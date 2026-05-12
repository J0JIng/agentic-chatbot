import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import * as z from "zod";
import agentConfig from "./agentConfig.json";
import { callModerationAPI } from "@/lib/moderationClient";
import { log } from "@/lib/logger";
import pipelineConfig from "@/agents/pipelineConfig.json";

const config = agentConfig.agents.outputGuard;

interface OutputRuleResult {
  score: number;
  reasons: string[];
}

const OUTPUT_RULES = [
  {
    id: "out_of_scope_promotion",
    label: "Policy Violation: Promotion of Unsupported External Vendors",
    patterns: [
      /you\s+should\s+(buy|purchase|subscribe\s+to)\s+(udemy|skillshare|masterclass|brilliant\.org)/gi,
      /switch\s+(away\s+from|to)\s+(a\s+)?competitor/gi,
    ],
    weight: 0.8,
  },
  {
    id: "ai_refusal",
    label: "Hallucination/Refusal Pattern",
    patterns: [
      /as\s+an\s+ai\s+language\s+model/gi,
      /i\s+cannot\s+fulfill\s+this/gi,
      /i'm\s+sorry,\s+but\s+i/gi,
    ],
    weight: 0.4,
  },
  {
    id: "pii_leak",
    label: "Security: PII Leakage Detection",
    patterns: [
      /\b\d{3}-\d{2}-\d{4}\b/g,                                    // SSN
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,       // Email
      /\b[STFGM]\d{7}[A-Z]\b/g,                                     // Singapore NRIC
      /\b(\+\d{1,3}[\s-])?\(?\d{3,4}\)?[\s-]?\d{3,4}[\s-]?\d{4}\b/g, // Phone number
      /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,                  // Credit card
    ],
    weight: 0.8,
  },
];

function runOutputRuleEngine(output: string): OutputRuleResult {
  let totalScore = 0;
  const reasons: string[] = [];

  for (const rule of OUTPUT_RULES) {
    if (rule.patterns.some((p) => { p.lastIndex = 0; return p.test(output); })) {
      totalScore += rule.weight;
      reasons.push(rule.label);
    }
  }

  return { score: Math.min(totalScore, 1.0), reasons };
}

// Hallucination risk assessed by data-source provenance, not LLM self-evaluation.

const EXTERNAL_CLAIM_PATTERNS = [
  /\baccording to\b/i,
  /\bstudies show\b/i,
  /\bresearch found\b/i,
  /\bstatistics show\b/i,
  /\b\d{4} report\b/i,
  /\bas of \d{4}\b/i,
];

function assessGroundingRisk(output: string): "low" | "medium" | "high" {
  // Course cards and platform knowledge results are fully grounded in database / tool output
  if (output.includes("[COURSE_CARD]") || output.includes("[FAQ_RESULT]") || output.includes("[RECOMMENDATION_META]")) {
    return "low";
  }

  // Multiple simultaneous external claims indicate a higher probability of ungrounded assertions
  // → "high" risk triggers hallucination_warning. A single match is "medium" but does not.
  const matchCount = EXTERNAL_CLAIM_PATTERNS.filter(p => p.test(output)).length;

  if (matchCount >= 2) return "high";
  if (matchCount >= 1) return "medium";

  return "low";
}

// sanitizedOutput removed: LLM echoed the full responseText causing truncated JSON output.
const policySchema = z.object({
  isSafe: z.boolean().describe("Whether the output is safe and appropriate to deliver"),
  policyCompliant: z
    .boolean()
    .describe("Whether the output complies with platform policies"),
  reasons: z
    .array(z.string())
    .describe("List of policy issues found, if any. Empty array if compliant."),
});

let cachedLLM: ReturnType<typeof buildLLM> | null = null;

function buildLLM() {
  // Timeout prevents hanging during OpenAI degradation
  return new ChatOpenAI({
    model: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeout: pipelineConfig.guards.timeoutMs,
  }).withStructuredOutput(policySchema);
}

/** Runs four-layer output validation (rule engine → moderation API → grounding heuristic → LLM) and returns a safety result. */
export async function validateOutput(
  output: string
): Promise<{
  isSafe: boolean;
  toxicityScore: number;
  hallucinationRisk: string;
  policyCompliant: boolean;
  reasons: string[];
}> {

  const ruleResult = runOutputRuleEngine(output);
  if (ruleResult.score >= pipelineConfig.guards.outputBlockThreshold) {
    return {
      isSafe: false,
      toxicityScore: 1.0,
      hallucinationRisk: "high",
      policyCompliant: false,
      reasons: ruleResult.reasons,
    };
  }

  const moderation = await callModerationAPI(output);
  if (moderation.flagged) {
    log({ level: "info", node: "outputGuardNode", isSafe: false, message: `Layer 2 (Moderation API) flagged: ${moderation.categories.join(", ")}` });
    return {
      isSafe: false,
      toxicityScore: 1.0,
      hallucinationRisk: "low",
      policyCompliant: false,
      reasons: [...ruleResult.reasons, ...moderation.categories.map((c) => `Moderation: ${c}`)],
    };
  }

  const hallucinationRisk = assessGroundingRisk(output);

  try {
    if (!cachedLLM) cachedLLM = buildLLM();

    const result = await cachedLLM.invoke([
      new SystemMessage(config.systemPrompt),
      new HumanMessage(
        `Check this response for platform policy compliance ONLY. Do NOT assess toxicity or factual accuracy — those are handled by separate systems.\n\nResponse to check:\n"${output}"`
      ),
    ]);

    return {
      isSafe: result.isSafe && ruleResult.score < pipelineConfig.guards.outputBlockThreshold,
      toxicityScore: moderation.flagged ? 1.0 : 0.0,
      hallucinationRisk,
      policyCompliant: result.policyCompliant,
      reasons: Array.from(new Set([...ruleResult.reasons, ...(result.reasons ?? [])])),
    };
  } catch (error) {
    log({ level: "error", node: "outputGuardNode", message: "LLM layer error", error: String(error) });
    return {
      isSafe: ruleResult.score < pipelineConfig.guards.outputFallbackThreshold && !moderation.flagged,
      toxicityScore: moderation.flagged ? 1.0 : 0.0,
      hallucinationRisk,
      policyCompliant: ruleResult.score === 0,
      reasons: ruleResult.reasons,
    };
  }
}
