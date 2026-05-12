import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import agentConfig from "./agentConfig.json";
import pipelineConfig from "./pipelineConfig.json";
import * as z from "zod";
import { ObservedSignal } from "./profileObserverAgent";

const config = agentConfig.agents.profileAuditor;

const auditorSchema = z.object({
  inferredInterests: z.array(z.string()).describe("NEW interests to be added. Do not include existing ones."),
  inferredSkillLevel: z.enum(["beginner", "intermediate", "advanced", "not_specified"]),
  inferredCognitiveLevel: z.enum([
    "remember",
    "understand",
    "apply",
    "analyse",
    "evaluate",
    "create",
    "not_specified",
  ]).describe("User's Bloom's Taxonomy cognitive level inferred from how they describe their learning goals and current understanding."),
  reasoning: z.string().describe("Explanation for why these specific updates were chosen."),
});

function buildAuditorLLM() {
  const model = new ChatOpenAI({
    model: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeout: pipelineConfig.guards.timeoutMs,
  });
  return model.withStructuredOutput(auditorSchema);
}

let cachedAuditorLLM: ReturnType<typeof buildAuditorLLM> | null = null;

/** Reconciles raw signals from the Observer into validated profile updates. */
export async function auditSignals(
  rawSignals: ObservedSignal[],
  profileContext: string,
  chatLog: string
) {
  if (!cachedAuditorLLM) cachedAuditorLLM = buildAuditorLLM();

  const signalSummary = rawSignals
    .map(
      (s, i) =>
        `[${i + 1}] topic="${s.topic}" confidence=${s.confidence} type=${s.type} sourceMsg=${s.sourceMessageIndex}`
    )
    .join("\n");

  const response = await cachedAuditorLLM.invoke([
    new SystemMessage(config.systemPrompt),
    new HumanMessage(
      `${profileContext}\n\n` +
      `RAW SIGNALS FROM OBSERVER (structured):\n${signalSummary}\n\n` +
      `LATEST CONVERSATION LOG FOR CONTEXT:\n${chatLog}\n\n` +
      `[TASK]: Reconcile signals. Give priority to high-confidence and explicit signals. ` +
      `Do NOT add negative-type signals — they indicate the user already knows or doesn't want the topic.`
    ),
  ]);

  return response;
}
