import { observeSignals } from "./profileObserverAgent";
import { auditSignals } from "./profileAuditorAgent";
import { AIInferredProfile, MergedProfile, UserData } from "@/lib/UserService";
import { db } from "../lib/firebaseAdmin";
import { log } from "@/lib/logger";
import pipelineConfig from "@/agents/pipelineConfig.json";

/** Reads the user's merged profile from Firestore, combining user-defined and AI-inferred data. */
export async function getUserMergedProfileData(userId: string): Promise<MergedProfile | null> {
  if (!userId) return null;
  const userDoc = await db.collection("users").doc(userId).get();

  if (userDoc.exists) {
    const data = userDoc.data() as UserData;
    return {
      userDefined: {
        name: data?.personalInfo?.name || "",
        skills: data?.skills || [],
      },
      aiDefined: {
        inferredInterests: data?.aiProfile?.inferredInterests || [],
        inferredSkillLevel: data?.aiProfile?.inferredSkillLevel || "beginner",
        inferredCognitiveLevel: data?.aiProfile?.inferredCognitiveLevel || "not_specified",
        interestWeights: data?.aiProfile?.interestWeights,
        lastReasoningTrace: data?.aiProfile?.lastReasoningTrace,
        lastUpdated: data?.aiProfile?.lastUpdated || "",
      },
      hasAiData: !!data?.aiProfile,
    };
  }
  return null;
}

/** Persists the AI-inferred profile fields to Firestore. */
export async function updateAIProfileData(userId: string, profile: AIInferredProfile) {
  await db.collection("users").doc(userId).set({ aiProfile: profile }, { merge: true });
  log({ level: "info", node: "userProfiling", message: "AI profile updated successfully" });
}

const DECAY_HALF_LIFE_DAYS = pipelineConfig.profiling.decayHalfLifeDays;
const DECAY_CULL_THRESHOLD = pipelineConfig.profiling.cullThreshold;

function applyDecay(
  weights: Record<string, { weight: number; lastUpdated: string }>,
  now: Date
): Record<string, { weight: number; lastUpdated: string }> {
  const decayed: Record<string, { weight: number; lastUpdated: string }> = {};

  for (const [topic, entry] of Object.entries(weights)) {
    const lastUpdated = new Date(entry.lastUpdated);
    const daysDiff = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
    const decayedWeight = entry.weight * Math.pow(0.5, daysDiff / DECAY_HALF_LIFE_DAYS);

    if (decayedWeight >= DECAY_CULL_THRESHOLD) {
      decayed[topic] = { weight: decayedWeight, lastUpdated: entry.lastUpdated };
    }
    // Topics below threshold are silently dropped (culled)
  }

  return decayed;
}

/**
 * Merges incoming profiling signals into the current AI profile, applying
 * exponential interest decay before merging and sorting interests by weight.
 */
export function createNewAIProfileData(
  current: AIInferredProfile | undefined,
  incoming: any,
  reasoningTrace?: string
): AIInferredProfile {
  const now = new Date();
  const nowISO = now.toISOString();

  const existingWeights: Record<string, { weight: number; lastUpdated: string }> =
    current?.interestWeights ?? {};

  const decayedWeights = applyDecay(existingWeights, now);

  const newInterests: string[] = incoming.inferredInterests ?? [];

  for (const interest of newInterests) {
    const key = interest.toLowerCase().trim();
    if (!key) continue;
    // Reinforce: boost existing weight back to 1.0
    decayedWeights[key] = { weight: 1.0, lastUpdated: nowISO };
  }

  const sortedInterests = Object.entries(decayedWeights)
    .sort(([, a], [, b]) => b.weight - a.weight)
    .map(([topic]) => topic.charAt(0).toUpperCase() + topic.slice(1));

  const updatedSkill =
    incoming.inferredSkillLevel !== "not_specified"
      ? incoming.inferredSkillLevel
      : current?.inferredSkillLevel || "beginner";

  const updatedCognitiveLevel =
    incoming.inferredCognitiveLevel !== "not_specified"
      ? incoming.inferredCognitiveLevel
      : current?.inferredCognitiveLevel || "not_specified";

  return {
    inferredInterests: sortedInterests,
    inferredSkillLevel: updatedSkill,
    inferredCognitiveLevel: updatedCognitiveLevel,
    interestWeights: decayedWeights,
    // Persist reasoning trace for explainability
    lastReasoningTrace: reasoningTrace ?? current?.lastReasoningTrace,
    lastUpdated: nowISO,
  };
}

const LEARNING_SIGNAL_PATTERNS = [
  /want\s+to\s+learn/i,
  /interested\s+in/i,
  /studying/i,
  /working\s+on/i,
  /my\s+(job|work|project|career)/i,
  /i('m|\s+am)\s+(learning|studying|building|working|exploring)/i,
  /how\s+do\s+i/i,
  /how\s+does/i,
  /can\s+you\s+explain/i,
  /i\s+want\s+to\s+(build|create|make|develop|understand)/i,
  /what\s+is\s+the\s+difference/i,
  /recommend.*course/i,
];

function hasProfilingSignals(
  messages: { role: string; content: string }[],
  assistantResponse: string
): boolean {
  if (assistantResponse.includes("[COURSE_CARD]")) return true;

  const recentUserText = messages
    .filter((m) => m.role === "user")
    .slice(-pipelineConfig.profiling.recentUserMessageCount)
    .map((m) => m.content)
    .join(" ");

  // Very short turns rarely carry learning signals
  if (recentUserText.trim().length < pipelineConfig.profiling.minSignalLength) return false;

  return LEARNING_SIGNAL_PATTERNS.some((p) => p.test(recentUserText));
}

/** Runs the Observer→Auditor profiling pipeline and persists the updated AI profile. */
export async function analyseAndProfileUser(
  userId: string,
  messages: { role: string; content: string }[]
) {
  if (!userId || !messages.length) return;

  try {
    const assistantResponse = messages[messages.length - 1]?.content ?? "";

    if (!hasProfilingSignals(messages, assistantResponse)) {
      log({ level: "info", node: "userProfiling", message: "Gate — no learning signals detected, skipping" });
      return;
    }

    log({ level: "info", node: "userProfiling", message: "Orchestrating Two-Stage Modular Pipeline" });

    const currentProfile = await getUserMergedProfileData(userId);

    const chatLog = messages
      .slice(-pipelineConfig.profiling.chatLogDepth)
      .map((m, idx) => {
        const cleanContent = m.content
          .replace(/<thought>[\s\S]*?<\/thought>/g, "")
          .replace(/\[RECOMMENDATION_META\][\s\S]*?\[\/RECOMMENDATION_META\]/g, "")
          .trim();
        return `[${idx}] ${m.role.toUpperCase()}: ${cleanContent}`;
      })
      .filter((line) => line.split(": ")[1]?.length > 2)
      .join("\n---\n");

    if (!chatLog.trim()) return;

    const rawSignals = await observeSignals(chatLog);
    if (!rawSignals || rawSignals.length === 0) return;

    //auditor prompt also excludes negatives
    const positiveSignals = rawSignals.filter((s) => s.type !== "negative");
    if (positiveSignals.length === 0) return;

    log({ level: "info", node: "userProfiling", message: "Stage 2 - Auditor" });
    const profileContext = currentProfile
      ? `CURRENT PROFILE: ${JSON.stringify(currentProfile.aiDefined)}`
      : "CURRENT PROFILE: No existing data.";

    // Pass full structured signals (including negatives) so Auditor has complete context
    const auditorResponse = await auditSignals(rawSignals, profileContext, chatLog);
    if (!auditorResponse) return;

    const updatedProfile = createNewAIProfileData(
      currentProfile?.aiDefined,
      auditorResponse,
      auditorResponse.reasoning
    );

    await updateAIProfileData(userId, updatedProfile);
  } catch (error) {
    log({ level: "error", node: "userProfiling", message: "Orchestration error", error: String(error) });
  }
}
