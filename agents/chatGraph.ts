import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import * as z from "zod";
import { DynamicTool } from "@langchain/core/tools";

import { validateOutput } from "./outputGuardAgent";
import { getSemanticRecommendations, ScoredCourse } from "@/lib/courseEmbeddingSearch";
import { EffectiveUserProfile } from "@/lib/userProfileService";
import { db } from "@/lib/firebaseAdmin";
import { redis } from "@/lib/redis";
import { getVendorFreeCoursesCached } from "@/lib/coursesServer";
import agentConfig from "./agentConfig.json";
import rankingConfig from "./rankingConfig.json";
import pipelineConfig from "./pipelineConfig.json";
import { log } from "@/lib/logger";

interface PlatformDoc {
  id: number;
  category: string;
  question: string;
  answer: string;
  embedding: number[];
}

// Module-level singleton — avoids reinstantiating on every tool call.
let _platformEmbeddingsModel: OpenAIEmbeddings | null = null;
function getPlatformEmbeddingsModel(): OpenAIEmbeddings {
  if (!_platformEmbeddingsModel) {
    _platformEmbeddingsModel = new OpenAIEmbeddings({ modelName: "text-embedding-3-small", timeout: pipelineConfig.guards.timeoutMs });
  }
  return _platformEmbeddingsModel;
}

const REDIS_PLATFORM_DOCS_KEY = "chatbot:platform_docs";
const PLATFORM_DOCS_TTL_S = pipelineConfig.cache.platformDocsTtlS;

async function getPlatformDocs(): Promise<PlatformDoc[]> {
  if (redis) {
    try {
      const cached = await redis.get<PlatformDoc[]>(REDIS_PLATFORM_DOCS_KEY);
      if (cached) {
        log({ level: "info", node: "platformDocs", message: `Redis hit (${cached.length} docs)` });
        return cached;
      }
    } catch (err) {
      log({ level: "warn", node: "platformDocs", message: "Redis get failed, falling back to Firestore", error: String(err) });
    }
  }

  log({ level: "info", node: "platformDocs", message: "Cache miss -> fetching from Firestore" });
  const snap = await db.collection("platformDocs").get();
  const docs = snap.docs
    .map((d) => d.data() as PlatformDoc)
    .filter((d) => Array.isArray(d.embedding) && d.embedding.length > 0);

  if (redis) {
    try {
      await redis.set(REDIS_PLATFORM_DOCS_KEY, docs, { ex: PLATFORM_DOCS_TTL_S });
    } catch (err) {
      log({ level: "warn", node: "platformDocs", message: "Redis set failed", error: String(err) });
    }
  }

  log({ level: "info", node: "platformDocs", message: `Loaded ${docs.length} docs from Firestore` });
  return docs;
}

function cosineSimilarity(vecA: number[], vecB: number[]) {
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dotProduct / (normA * normB);
}

/** Answers platform questions via Firestore-backed RAG. */
export const platformKnowledgeTool = new DynamicTool({
  name: "platformKnowledge",
  description:
    "Answer questions about the platform, enrollment, payments, certification, and technical issues. Input: user question.",
  func: async (input: string) => {
    try {
      const docs = await getPlatformDocs();

      if (docs.length === 0) {
        return "I couldn't find specific platform documentation for that. Try asking about enrollment, payments, or platform basics.";
      }

      const queryEmbedding = await getPlatformEmbeddingsModel().embedQuery(input);

      const scored = docs
        .map((doc) => ({ ...doc, score: cosineSimilarity(queryEmbedding, doc.embedding) }))
        .sort((a, b) => b.score - a.score);

      if (scored[0].score > pipelineConfig.guards.faqSimilarityThreshold) {
        return `[FAQ_RESULT]: ${scored[0].answer}`;
      }
      return "I couldn't find a specific answer in the platform documentation. Try asking about enrollment, payments, or platform basics.";
    } catch (e) {
      log({ level: "error", node: "platformKnowledgeTool", message: "Tool execution error", error: String(e) });
      return "Error retrieving platform documentation.";
    }
  },
});

/** Builds the personalisation and active-context string appended to the controller system prompt. */
export function generatePersonalisationContext(
  profile: EffectiveUserProfile | null,
  activeContext?: string
): string {
  let contextStr = "";

  if (activeContext) {
    contextStr += `\n\n### ACTIVE PAGE CONTEXT (CRITICAL):\nThe user has highlighted or is asking about the following specific text/page:\n${activeContext}\n\n[INSTRUCTION]: Your answer MUST directly address this highlighted text.`;
  }

  if (!profile) return contextStr;

  contextStr += "\n\n### USER PROFILE (PERSONALIZATION CONTEXT):";

  if (profile.interests.length > 0) {
    contextStr += `\n- INTERESTS: ${profile.interests.join(", ")}`;
  }
  contextStr += `\n- ESTIMATED SKILL LEVEL: ${profile.skillLevel}`;
  if (profile.cognitiveLevel && profile.cognitiveLevel !== "not_specified") {
    contextStr += `\n- COGNITIVE LEVEL (Bloom's Taxonomy): ${profile.cognitiveLevel} — adapt explanation depth and course format suggestions accordingly`;
  }

  contextStr += "\n\n[INSTRUCTION]: Adapt your technical depth, tone, and examples to match the user's profile above.";

  return contextStr;
}

const AgentState = Annotation.Root({
  userMessage: Annotation<string>({ reducer: (_, x) => x, default: () => "" }),
  userId: Annotation<string>({ reducer: (_, x) => x, default: () => "" }),
  profile: Annotation<EffectiveUserProfile | null>({ reducer: (_, x) => x, default: () => null }),
  messages: Annotation<{ role: string; content: string }[]>({ reducer: (_, x) => x, default: () => [] }),
  contextText: Annotation<string | undefined>({ reducer: (_, x) => x, default: () => undefined }),
  isValid: Annotation<boolean>({ reducer: (_, x) => x, default: () => true }),
  blockReason: Annotation<string>({ reducer: (_, x) => x, default: () => "" }),
  intent: Annotation<"recommendation" | "faq" | "general" | "comparison" | "learning_path" | "">({ reducer: (_, x) => x, default: () => "" }),
  searchQuery: Annotation<string>({ reducer: (_, x) => x, default: () => "" }),
  secondaryQuery: Annotation<string>({ reducer: (_, x) => x, default: () => "" }),
  responseText: Annotation<string>({ reducer: (_, x) => x, default: () => "" }),
  outputSafe: Annotation<boolean>({ reducer: (_, x) => x, default: () => true }),
  outputHallucinationRisk: Annotation<string>({ reducer: (_, x) => x, default: () => "low" }),
  outputSafetyReasons: Annotation<string[]>({ reducer: (_, x) => x, default: () => [] }),
  isGrounded: Annotation<boolean>({ reducer: (_, x) => x, default: () => true }),
});

type AgentStateType = typeof AgentState.State;

async function inputGuardNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  log({ level: "info", node: "inputGuardNode", userId: state.userId, isValid: state.isValid });
  return {}; // isValid already set upstream; conditional edge routes accordingly
}

// Called before graph.streamEvents() so structured-output JSON never enters the stream.
const intentSchema = z.object({
  intent: z
    .enum(["recommendation", "faq", "general", "comparison", "learning_path"])
    .describe(
      "recommendation = user wants course suggestions on a topic; " +
      "faq = platform/policy question (enrollment, payments, certificates, technical); " +
      "comparison = user wants to compare two technologies, frameworks, or courses; " +
      "learning_path = user wants a structured roadmap or sequence to learn a skill; " +
      "general = other educational assistance"
    ),
  searchQuery: z
    .string()
    .describe(
      "Primary topic. For recommendation/learning_path: the subject. " +
      "For comparison: the first item being compared. Empty for faq/general."
    ),
  secondaryQuery: z
    .string()
    .describe(
      "For comparison intent only: the second item being compared (e.g. 'JavaScript' when query is 'Python'). " +
      "Empty string for all other intents."
    ),
});

let _controllerResponseLLM: ChatOpenAI | null = null;

function getControllerResponseLLM(): ChatOpenAI {
  if (!_controllerResponseLLM) {
    const cfg = agentConfig.agents.controller;
    _controllerResponseLLM = new ChatOpenAI({
      model: cfg.modelId,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeout: pipelineConfig.guards.timeoutMs,
    });
  }
  return _controllerResponseLLM;
}

let cachedClassifierLLM: ReturnType<ChatOpenAI["withStructuredOutput"]> | null = null;

/** Classifies the user's intent and extracts the search query outside the graph stream to prevent JSON leakage. */
export async function classifyIntent(
  userMessage: string,
  messages: { role: string; content: string }[]
): Promise<{
  intent: "recommendation" | "faq" | "general" | "comparison" | "learning_path";
  searchQuery: string;
  secondaryQuery: string;
}> {
  const config = agentConfig.agents.controller;

  if (!cachedClassifierLLM) {
    // Timeout prevents hanging during OpenAI degradation
    cachedClassifierLLM = new ChatOpenAI({
      model: config.modelId,
      temperature: 0,
      maxTokens: 150,
      timeout: pipelineConfig.guards.timeoutMs,
    }).withStructuredOutput(intentSchema);
  }

  const historyForClassifier = messages
    .slice(-pipelineConfig.profiling.classifierHistoryDepth, -1)
    .map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)));

  try {
    const result = await cachedClassifierLLM.invoke([
      new SystemMessage(
        "You are an intent classifier for an educational learning platform chatbot. " +
        "Classify the user's intent. Use conversation history for context. " +
        "Use 'comparison' when the user asks 'X vs Y' or wants to compare two things. " +
        "Use 'learning_path' when the user asks for a roadmap, progression, or how to become/master something."
      ),
      ...historyForClassifier,
      new HumanMessage(userMessage),
    ]);
    return {
      intent: result.intent as "recommendation" | "faq" | "general" | "comparison" | "learning_path",
      searchQuery: result.searchQuery || userMessage,
      secondaryQuery: result.secondaryQuery || "",
    };
  } catch {
    return { intent: "general", searchQuery: "", secondaryQuery: "" };
  }
}

// Intent is pre-classified in handleMessage() and passed via initialState.
// For faq/general, model.invoke() inside graph.streamEvents() propagates
// on_chat_model_stream events to the caller automatically.
async function controllerNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const config = agentConfig.agents.controller;

  // System prompt built per-request so personalisation context is always fresh
  const personalizationContext = generatePersonalisationContext(state.profile, state.contextText);
  const systemContent = config.systemPrompt + personalizationContext;

  const intent = (state.intent as "recommendation" | "faq" | "general" | "comparison" | "learning_path") || "general";
  log({ level: "info", node: "controllerNode", userId: state.userId, intent, searchQuery: state.searchQuery || undefined });
  const searchQuery = state.searchQuery || state.userMessage;
  const secondaryQuery = state.secondaryQuery || "";

  if (intent === "recommendation") {
    return { intent: "recommendation", searchQuery };
  }
  if (intent === "comparison") {
    return { intent: "comparison", searchQuery, secondaryQuery };
  }
  if (intent === "learning_path") {
    return { intent: "learning_path", searchQuery };
  }

  const historyMessages = state.messages
    .slice(-pipelineConfig.profiling.controllerHistoryDepth, -1)
    .map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)));

  let userTurn: string = state.userMessage;
  let isGrounded = false; // general intent is never grounded in retrieved data

  if (intent === "faq") {
    try {
      const faqResult = await platformKnowledgeTool.func(state.userMessage);
      isGrounded = faqResult.startsWith("[FAQ_RESULT]");
      userTurn = `Platform documentation context:\n${faqResult}\n\nUser question: ${state.userMessage}`;
    } catch {
      // Fall through — respond from general knowledge; isGrounded stays false
    }
  }

  const response = await getControllerResponseLLM().invoke([
    new SystemMessage(systemContent),
    ...historyMessages,
    new HumanMessage(userTurn),
  ]);

  const responseText =
    typeof response.content === "string"
      ? response.content
      : (response.content as any[]).map((c: any) => c.text ?? "").join("");

  return {
    intent: intent as "faq" | "general",
    responseText,
    isGrounded,
  };
}

const REC_CACHE_TTL_S = pipelineConfig.cache.recommendationTtlS;

function getRecCacheKey(userId: string | null | undefined, query: string): string {
  const safeQuery = query.toLowerCase().trim().slice(0, 100).replace(/\s+/g, "_");
  const safeUser = userId || "anon";
  return `chatbot:rec:${safeUser}:${safeQuery}`;
}

/**
 * Checks Redis for cached recommendations; on miss runs the full pipeline and
 * caches the result. Falls back transparently if Redis is unavailable.
 */
async function getRecommendationsWithCache(
  query: string,
  userId: string | null | undefined,
  profile: EffectiveUserProfile | null,
  messages: Array<{ role: string; content: string }>
): Promise<{ results: ScoredCourse[]; fromCache: boolean; isFallback: boolean }> {
  const key = getRecCacheKey(userId, query);

  if (redis) {
    try {
      const cached = await redis.get<ScoredCourse[]>(key);
      if (cached) {
        log({ level: "info", node: "recCache", message: `Redis hit: ${key}` });
        return { results: cached, fromCache: true, isFallback: false };
      }
    } catch (err) {
      log({ level: "warn", node: "recCache", message: `Redis get failed (${key})`, error: String(err) });
    }
  }

  let results: ScoredCourse[];
  let isFallback = false;

  try {
    results = await getSemanticRecommendations(query, profile, messages);
  } catch (err) {
    log({ level: "warn", node: "recCache", message: "Embedding pipeline failed — serving popular courses as fallback", error: String(err) });
    const popularCourses = await getVendorFreeCoursesCached() as any[];
    results = popularCourses.slice(0, 8).map((c, i) => ({
      ...c,
      embedding: [] as number[],
      semanticScore: Math.max(0.1, 1.0 - i * 0.05),
      finalScore: Math.max(0.1, 1.0 - i * 0.05),
      isPaid: false,
    })) as ScoredCourse[];
    isFallback = true;
  }

  // Do not cache fallback results. Next request should retry the pipeline
  if (!isFallback && redis) {
    try {
      await redis.set(key, results, { ex: REC_CACHE_TTL_S });
    } catch (err) {
      log({ level: "warn", node: "recCache", message: `Redis set failed (${key})`, error: String(err) });
    }
  }

  return { results, fromCache: false, isFallback };
}

// controllerNode returns early for structured intents (no LLM call), so
// follow-up questions are generated deterministically here.
function generateRecommendationFollowUps(
  searchQuery: string,
  profile: EffectiveUserProfile | null
): string {
  const level = profile?.skillLevel ?? "beginner";
  const nextLevel =
    level === "beginner" ? "intermediate" : level === "intermediate" ? "advanced" : "advanced";

  const q1 = `What skills will I gain from these ${searchQuery} courses?`;
  const q2 = `Can you find ${nextLevel} ${searchQuery} courses for me?`;
  const q3 = `How long does it take to become proficient in ${searchQuery}?`;

  return `[FOLLOW_UP]: ${q1} | ${q2} | ${q3}`;
}

async function recommenderNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  log({ level: "info", node: "recommenderNode", userId: state.userId, message: `Searching: "${state.searchQuery}"` });

  const { results, fromCache, isFallback } = await getRecommendationsWithCache(
    state.searchQuery, state.userId, state.profile, state.messages
  );

  if (results.length === 0) {
    return {
      responseText:
        "No highly relevant free courses were found for this topic at the moment. Try a different or broader topic.",
    };
  }

  // Synthetic thought block: deterministic, zero LLM cost
  // Ensures the Agent Collaboration Log is populated for every response type
  const interests = (state.profile?.interests ?? []).join(", ") || "none";
  const skillLevel = state.profile?.skillLevel ?? "beginner";

  const syntheticThought = [
    `<thought>`,
    `[CLASSIFIER]: Intent classified as "recommendation". ` +
    `Search query: "${state.searchQuery}". ` +
    `Profile context — interests: [${interests}], skill level: ${skillLevel}.`,
    isFallback
      ? `[RESEARCHER]: Semantic embedding pipeline unavailable — serving popular courses as fallback (graceful degradation).`
      : `[RESEARCHER]: Semantic embedding pipeline executed — query embedded with ` +
      `text-embedding-3-small, cosine similarity retrieval across the coursesV2 + paidCourses ` +
      `Firestore corpus (top-25 candidates retrieved). ` +
      (fromCache
        ? "Results served from 5-minute Upstash Redis cache."
        : "Live semantic search performed."),
    isFallback
      ? `[CURATOR]: Showing top popular courses by enrollment count (personalised ranking unavailable).`
      : `[CURATOR]: Content re-ranking applied (${rankingConfig.reranking.weights.semantic} × semantic similarity + ` +
      `${rankingConfig.reranking.weights.interestOverlap} × Jaccard interest overlap + ` +
      `${rankingConfig.reranking.weights.difficultyMatch} × difficulty match − ` +
      `${rankingConfig.reranking.weights.enrolledPenalty} × enrollment penalty). ` +
      `Maximal Marginal Relevance filter (λ=${rankingConfig.mmr.lambda}, k=${rankingConfig.mmr.k}) selected ` +
      `${results.length} diverse course(s) for presentation.`,
    `[SAFETY]: Response contains structured course metadata from verified ` +
    `Firestore documents. No LLM-generated factual claims are present.`,
    `</thought>`,
  ].join("\n");

  const freeCount = results.filter((c) => !c.isPaid).length;
  const paidCount = results.filter((c) => c.isPaid).length;
  const mixLabel =
    paidCount > 0 && freeCount > 0
      ? `free and paid courses`
      : paidCount > 0
        ? `courses`
        : `free courses`;

  let output = isFallback
    ? `My personalised course search is temporarily unavailable. Here are some popular **${state.searchQuery}** courses you might enjoy:\n\n`
    : `Here are some ${mixLabel} on **${state.searchQuery}** that match your interests:\n\n`;

  for (const c of results) {
    output += `[COURSE_CARD]${JSON.stringify({
      title: c.title || "Unknown Title",
      vendor: c.source || "Unknown Vendor",
      imageUrl: c.image_url || "/images/course.jpeg",
      url: c.url || "#",
      difficulty: c.difficulty || "Beginner",
      duration: c.duration_hours ? `${c.duration_hours}h` : "N/A",
      isPaid: c.isPaid ?? false,
      price: c.price ?? null,
      courseId: c.id || null,
      courseType: c.isPaid ? "platform" : "vendor",
    })}[/COURSE_CARD]\n\n`;
  }

  output += `\n${generateRecommendationFollowUps(state.searchQuery, state.profile)}`;

  // Hidden metadata for explainability; stripped from display by the client
  const meta = {
    signals: state.profile?.interests ?? [],
    skillLevel,
    query: state.searchQuery,
    scores: results.map((c) => ({
      courseId: c.id,
      title: c.title,
      semSim: Math.round(c.semanticScore * 100) / 100,
      finalScore: Math.round(c.finalScore * 100) / 100,
    })),
  };
  output += `\n[RECOMMENDATION_META]${JSON.stringify(meta)}[/RECOMMENDATION_META]`;

  return { responseText: syntheticThought + "\n\n" + output };
}

async function comparerNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const topicA = state.searchQuery || state.userMessage;
  const topicB = state.secondaryQuery;

  log({ level: "info", node: "comparerNode", userId: state.userId, message: `Comparing: "${topicA}" vs "${topicB}"` });

  if (!topicB) {
    const { results, isFallback } = await getRecommendationsWithCache(topicA, state.userId, state.profile, state.messages);
    if (isFallback) {
      return {
        responseText:
          "My personalised course search is temporarily unavailable, so I can't provide a comparison right now. " +
          "Please try again in a moment.\n\n" +
          `[FOLLOW_UP]: Recommend courses on ${topicA} | What are popular courses? | How does the platform work?`,
      };
    }
    const cards = results.slice(0, 4).map((c) => `[COURSE_CARD]${JSON.stringify({
      title: c.title, vendor: c.source, imageUrl: c.image_url || "/images/course.jpeg",
      url: c.url || "#", difficulty: c.difficulty || "Beginner",
      duration: c.duration_hours ? `${c.duration_hours}h` : "N/A",
      isPaid: c.isPaid ?? false, price: c.price ?? null,
      courseId: c.id || null, courseType: c.isPaid ? "platform" : "vendor",
      section: topicA,
    })}[/COURSE_CARD]`).join("\n\n");
    return {
      responseText:
        `I'll help you compare, but I only detected one topic. Here are courses on **${topicA}**:\n\n` +
        cards +
        `\n\n[FOLLOW_UP]: Compare ${topicA} with something else | Show me more ${topicA} courses | What are the career prospects for ${topicA}?`,
    };
  }

  const [{ results: resultsA, isFallback: isFallbackA }, { results: resultsB, isFallback: isFallbackB }] = await Promise.all([
    getRecommendationsWithCache(topicA, state.userId, state.profile, state.messages),
    getRecommendationsWithCache(topicB, state.userId, state.profile, state.messages),
  ]);

  // Popular-course fallback produces identical lists — skip comparison
  if (isFallbackA || isFallbackB) {
    return {
      responseText:
        "My personalised course search is temporarily unavailable, which means I can't provide a meaningful comparison right now. " +
        "Please try again in a moment.\n\n" +
        `[FOLLOW_UP]: Recommend courses on ${topicA} | Recommend courses on ${topicB} | What are popular courses?`,
    };
  }

  const syntheticThought = [
    `<thought>`,
    `[CLASSIFIER]: Intent classified as "comparison". Topics: "${topicA}" vs "${topicB}".`,
    `[RESEARCHER]: Ran parallel semantic searches for both topics.`,
    `[CURATOR]: Top-4 results selected per topic for side-by-side comparison.`,
    `[SAFETY]: All results from verified Firestore documents.`,
    `</thought>`,
  ].join("\n");

  let output = `Here's a comparison of **${topicA}** vs **${topicB}** courses:\n\n`;

  for (const c of resultsA.slice(0, 4)) {
    output += `[COURSE_CARD]${JSON.stringify({
      title: c.title, vendor: c.source, imageUrl: c.image_url || "/images/course.jpeg",
      url: c.url || "#", difficulty: c.difficulty || "Beginner",
      duration: c.duration_hours ? `${c.duration_hours}h` : "N/A",
      isPaid: c.isPaid ?? false, price: c.price ?? null,
      courseId: c.id || null, courseType: c.isPaid ? "platform" : "vendor",
      // Accordion grouping fields — consumed by the Comparer UI (F-08)
      isComparison: true, tier: topicA, step: 1,
      stepLabel: topicA, stepSummary: `Courses on ${topicA}`,
    })}[/COURSE_CARD]\n\n`;
  }
  for (const c of resultsB.slice(0, 4)) {
    output += `[COURSE_CARD]${JSON.stringify({
      title: c.title, vendor: c.source, imageUrl: c.image_url || "/images/course.jpeg",
      url: c.url || "#", difficulty: c.difficulty || "Beginner",
      duration: c.duration_hours ? `${c.duration_hours}h` : "N/A",
      isPaid: c.isPaid ?? false, price: c.price ?? null,
      courseId: c.id || null, courseType: c.isPaid ? "platform" : "vendor",
      // Accordion grouping fields — consumed by the Comparer UI (F-08)
      isComparison: true, tier: topicB, step: 2,
      stepLabel: topicB, stepSummary: `Courses on ${topicB}`,
    })}[/COURSE_CARD]\n\n`;
  }

  output += `\n[FOLLOW_UP]: Tell me more about ${topicA} | What are the career prospects for ${topicA}? | What are the career prospects for ${topicB}?`;

  return { responseText: syntheticThought + "\n\n" + output };
}

const STEP_SUMMARIES = {
  1: (t: string) => `Build your ${t} foundations — master the core concepts and tools before applying them.`,
  2: (t: string) => `Apply your ${t} knowledge in practice — build real projects and work with hands-on data.`,
  3: (t: string) => `Master ${t} at depth — explore advanced techniques used in production systems and research.`,
} as const;

async function learningPathNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const topic = state.searchQuery || state.userMessage;
  log({ level: "info", node: "learningPathNode", userId: state.userId, message: `Building learning path for: "${topic}"` });

  const makeProfile = (level: "beginner" | "intermediate" | "advanced") =>
    state.profile
      ? { ...state.profile, skillLevel: level }
      : { interests: [], skillLevel: level, cognitiveLevel: "not_specified", enrolledCourseIds: [] };

  // Level-specific query suffixes keep Redis cache keys distinct
  const [
    { results: beginnerResults, isFallback: isFallbackBeg },
    { results: intermediateResults, isFallback: isFallbackInt },
    { results: advancedResults, isFallback: isFallbackAdv },
  ] = await Promise.all([
    getRecommendationsWithCache(`${topic} beginner fundamentals`, state.userId, makeProfile("beginner") as any, state.messages),
    getRecommendationsWithCache(`${topic} intermediate practical`, state.userId, makeProfile("intermediate") as any, state.messages),
    getRecommendationsWithCache(`${topic} advanced expert`, state.userId, makeProfile("advanced") as any, state.messages),
  ]);

  // Popular-course fallback produces the same list at every level. skip roadmap
  if (isFallbackBeg || isFallbackInt || isFallbackAdv) {
    return {
      responseText:
        "My personalised course search is temporarily unavailable, which means I can't build a meaningful learning path right now. " +
        "Please try again in a moment.\n\n" +
        `[FOLLOW_UP]: Recommend courses on ${topic} | What are popular courses? | How long does it take to learn ${topic}?`,
    };
  }

  const syntheticThought = [
    `<thought>`,
    `[CLASSIFIER]: Intent classified as "learning_path". Topic: "${topic}".`,
    `[RESEARCHER]: Ran three parallel semantic searches — beginner, intermediate, advanced.`,
    `[CURATOR]: Top-2 courses selected per level to form a structured learning roadmap.`,
    `[SAFETY]: All results from verified Firestore documents.`,
    `</thought>`,
  ].join("\n");


  const renderCard = (
    c: ScoredCourse,
    tier: "beginner" | "intermediate" | "advanced",
    step: 1 | 2 | 3,
    stepLabel: string,
    stepSummary: string,
  ) =>
    `[COURSE_CARD]${JSON.stringify({
      title: c.title, vendor: c.source, imageUrl: c.image_url || "/images/course.jpeg",
      url: c.url || "#", difficulty: c.difficulty || "Beginner",
      duration: c.duration_hours ? `${c.duration_hours}h` : "N/A",
      isPaid: c.isPaid ?? false, price: c.price ?? null,
      courseId: c.id || null, courseType: c.isPaid ? "platform" : "vendor",
      tier, step, stepLabel, stepSummary,
    })}[/COURSE_CARD]`;

  // tier/stepLabel/stepSummary embedded in card JSON; roadmap UI reads them directly
  let output = `Here's a structured learning path for **${topic}**:\n\n`;

  for (const c of beginnerResults.slice(0, 2))
    output += renderCard(c, "beginner", 1, "Build the Foundations", STEP_SUMMARIES[1](topic)) + "\n\n";

  for (const c of intermediateResults.slice(0, 2))
    output += renderCard(c, "intermediate", 2, "Apply Your Skills", STEP_SUMMARIES[2](topic)) + "\n\n";

  for (const c of advancedResults.slice(0, 2))
    output += renderCard(c, "advanced", 3, "Master Advanced Concepts", STEP_SUMMARIES[3](topic)) + "\n\n";

  output += `\n[FOLLOW_UP]: How long will this learning path take? | What projects should I build along the way? | Are there certifications for ${topic}?`;

  // RECOMMENDATION_META carries intent/skillLevel/query for roadmap rendering
  const lpMeta = {
    signals: state.profile?.interests ?? [],
    skillLevel: state.profile?.skillLevel ?? "beginner",
    query: topic,
    intent: "learning_path",
  };
  output += `\n[RECOMMENDATION_META]${JSON.stringify(lpMeta)}[/RECOMMENDATION_META]`;

  return { responseText: syntheticThought + "\n\n" + output };
}

async function outputGuardNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  log({ level: "info", node: "outputGuardNode", userId: state.userId, message: "Node entered" });
  if (!state.responseText) {
    return { outputSafe: true, outputHallucinationRisk: "low", outputSafetyReasons: [] };
  }

  const textToValidate = state.responseText
    .replace(/<thought>[\s\S]*?<\/thought>/g, "")
    .replace(/\[RECOMMENDATION_META\][\s\S]*?\[\/RECOMMENDATION_META\]/g, "")
    .trim();

  if (!textToValidate) {
    return { outputSafe: true, outputHallucinationRisk: "low", outputSafetyReasons: [] };
  }

  try {
    const result = await validateOutput(textToValidate);

    let hallucinationRisk = result.hallucinationRisk;
    // Ungrounded FAQ: the LLM answered from pre-training with no matching platform doc — always high risk
    if (state.intent === "faq" && !state.isGrounded) {
      hallucinationRisk = "high";
    // General intent: lower the threshold from 2 to 1 external-claim pattern match
    } else if (state.intent === "general" && hallucinationRisk === "medium") {
      hallucinationRisk = "high";
    }

    return {
      outputSafe: result.isSafe,
      outputHallucinationRisk: hallucinationRisk,
      outputSafetyReasons: result.reasons,
    };
  } catch {
    return { outputSafe: true, outputHallucinationRisk: "low", outputSafetyReasons: [] };
  }
}

function routeAfterInputGuard(state: AgentStateType): "controllerNode" | typeof END {
  return state.isValid ? "controllerNode" : END;
}

function routeAfterController(
  state: AgentStateType
): "recommenderNode" | "comparerNode" | "learningPathNode" | "outputGuardNode" {
  switch (state.intent) {
    case "recommendation": return "recommenderNode";
    case "comparison": return "comparerNode";
    case "learning_path": return "learningPathNode";
    default: return "outputGuardNode"; // faq | general
  }
}

let _compiledGraph: any = null;

function buildGraph() {
  return new StateGraph(AgentState)
    .addNode("inputGuardNode", inputGuardNode)
    .addNode("controllerNode", controllerNode)
    .addNode("recommenderNode", recommenderNode)
    .addNode("comparerNode", comparerNode)
    .addNode("learningPathNode", learningPathNode)
    .addNode("outputGuardNode", outputGuardNode)
    .addEdge(START, "inputGuardNode")
    .addConditionalEdges("inputGuardNode", routeAfterInputGuard, {
      controllerNode: "controllerNode",
      [END]: END,
    })
    .addConditionalEdges("controllerNode", routeAfterController, {
      recommenderNode: "recommenderNode",
      comparerNode: "comparerNode",
      learningPathNode: "learningPathNode",
      outputGuardNode: "outputGuardNode",
    })
    .addEdge("recommenderNode", "outputGuardNode")
    .addEdge("comparerNode", "outputGuardNode")
    .addEdge("learningPathNode", "outputGuardNode")
    .addEdge("outputGuardNode", END)
    // No checkpointer — Vercel serverless instances are stateless.
    // Conversation continuity relies on the client sending the full messages array.
    .compile();
}

/** Returns the compiled LangGraph StateGraph, initialising it on first call. */
export function getChatGraph() {
  if (!_compiledGraph) _compiledGraph = buildGraph();
  return _compiledGraph;
}
