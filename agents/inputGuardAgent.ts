import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import * as z from "zod";
import agentConfig from "./agentConfig.json";
import { callModerationAPI } from "@/lib/moderationClient";
import { log } from "@/lib/logger";
import pipelineConfig from "@/agents/pipelineConfig.json";

const config = agentConfig.agents.inputGuard;

interface RuleResult {
  score: number;
  threats: string[];
}

const SECURITY_RULES = [
  {
    id: "instruction_override",
    label: "Prompt Injection: Instruction Override",
    patterns: [
      /ignore\s+(all\s+)?previous/gi,
      /disregard\s+instructions/gi,
      /system\s+override/gi,
      /forget\s+everything/gi,
    ],
    weight: 0.9,
  },
  {
    id: "persona_hijack",
    label: "Prompt Injection: Persona Hijacking",
    patterns: [
      /you\s+are\s+now/gi,
      /act\s+as\s+a/gi,
      /become\s+my/gi,
      /dan\s+mode/gi,
      /jailbreak/gi,
    ],
    weight: 0.7,
  },
  {
    id: "system_leakage",
    label: "Data Leakage: System Prompt Request",
    patterns: [
      /reveal\s+your\s+prompt/gi,
      /print\s+text\s+above/gi,
      /show\s+initial\s+instructions/gi,
      /output\s+initial/gi,
    ],
    weight: 1.0,
  },
  {
    // Targets sensitive data extraction — no SQL surface exists in this Firestore-backed platform
    id: "sensitive_data_extraction",
    label: "Attack: Sensitive Data Extraction Attempt",
    patterns: [
      /\bapi[\s_-]?key\b/gi,
      /\bsecret[\s_-]?key\b/gi,
      /\baccess[\s_-]?token\b/gi,
      /show\s+(me\s+)?all\s+users/gi,
      /dump\s+(the\s+)?(database|data|users|records)/gi,
      /list\s+all\s+(user|account|email)/gi,
    ],
    weight: 0.7,
  },
  {
    id: "markdown_exfiltration",
    label: "Attack: Markdown Exfiltration",
    patterns: [/!\[.*\]\(http.*\)/gi, /\[.*\]\(javascript:.*\)/gi],
    weight: 0.6,
  },
];

function runRuleEngine(input: string): RuleResult {
  const normalized = input.toLowerCase().replace(/[\s\._\-\*]+/g, " ");
  let totalScore = 0;
  const detected: string[] = [];

  for (const rule of SECURITY_RULES) {
    if (rule.patterns.some((p) => {
      p.lastIndex = 0;
      if (p.test(normalized)) return true;
      p.lastIndex = 0;
      return p.test(input);
    })) {
      totalScore += rule.weight;
      detected.push(rule.label);
    }
  }

  return { score: Math.min(totalScore, 1.0), threats: detected };
}

const responseSchema = z.object({
  isValid: z.boolean().describe("Whether the input is safe and on-topic"),
  reason: z.string().describe("Explanation of the validation decision"),
  threats: z.array(z.string()).describe("Detected threat types, if any"),
  sanitizedInput: z
    .string()
    .describe("Lightly cleaned version of the input, or the original if clean"),
});

let cachedLLM: ReturnType<typeof buildLLM> | null = null;

function buildLLM() {
  // Timeout prevents hanging during OpenAI degradation; fail-open path in catch block
  return new ChatOpenAI({
    model: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeout: pipelineConfig.guards.timeoutMs,
  }).withStructuredOutput(responseSchema);
}

const MAX_INPUT_LENGTH = pipelineConfig.guards.maxInputLength;

/** Runs three-layer input validation (rule engine → moderation API → LLM) and returns a safety result. */
export async function validateInput(
  userInput: string,
  signal?: AbortSignal
): Promise<{ isValid: boolean; reason: string; threats: string[]; sanitizedInput: string }> {

  if (userInput.length > MAX_INPUT_LENGTH) {
    return {
      isValid: false,
      reason: `Message exceeds the ${MAX_INPUT_LENGTH.toLocaleString()}-character limit. Please shorten your message and try again.`,
      threats: [],
      sanitizedInput: userInput,
    };
  }

  const ruleResult = runRuleEngine(userInput);
  if (ruleResult.score >= pipelineConfig.guards.inputBlockThreshold) {
    log({ level: "info", node: "inputGuardNode", isValid: false, message: `Layer 1 (Rule Engine) blocked: ${ruleResult.threats.join(", ")}` });
    return {
      isValid: false,
      reason: "Blocked by security rules: prompt injection or data exfiltration attempt detected.",
      threats: ruleResult.threats,
      sanitizedInput: userInput,
    };
  }

  const moderation = await callModerationAPI(userInput);
  if (moderation.flagged) {
    log({ level: "info", node: "inputGuardNode", isValid: false, message: `Layer 2 (Moderation API) blocked: ${moderation.categories.join(", ")}` });
    return {
      isValid: false,
      reason: `Content flagged by moderation: ${moderation.categories.join(", ")}.`,
      threats: moderation.categories,
      sanitizedInput: userInput,
    };
  }

  try {
    if (!cachedLLM) cachedLLM = buildLLM();

    const result = await cachedLLM.invoke(
      [
        new SystemMessage(config.systemPrompt),
        new HumanMessage(`Review this input for safety and relevance: "${userInput}"`),
      ],
      { signal } as any
    );

    return {
      isValid: result.isValid,
      reason: result.reason,
      threats: Array.from(new Set([...ruleResult.threats, ...(result.threats ?? [])])),
      sanitizedInput: result.sanitizedInput ?? userInput,
    };
  } catch (err: any) {
    if (err.name === "AbortError" || signal?.aborted) {
      return {
        isValid: false,
        reason: "Validation aborted.",
        threats: ruleResult.threats,
        sanitizedInput: userInput,
      };
    }
    // Fail open on LLM error — rule engine passed, treat as valid
    log({ level: "error", node: "inputGuardNode", message: "Layer 3 LLM error, failing open", error: String(err) });
    return {
      isValid: true,
      reason: "LLM layer unavailable; rule engine passed.",
      threats: ruleResult.threats,
      sanitizedInput: userInput,
    };
  }
}
