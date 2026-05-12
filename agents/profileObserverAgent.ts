import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import agentConfig from "./agentConfig.json";
import pipelineConfig from "./pipelineConfig.json";
import * as z from "zod";

const config = agentConfig.agents.profileObserver;

/** Zod schema for a single learning signal extracted from the conversation. */
export const observedSignalSchema = z.object({
  topic: z.string().describe("The learning topic or subject area (clean label, e.g. 'Python', 'Data Science')"),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("How certain the signal is: high = explicitly stated, medium = inferred, low = speculative"),
  type: z
    .enum(["explicit", "implicit", "negative", "contextual"])
    .describe(
      "explicit: user directly states they want to learn it; " +
      "implicit: inferred from a question or behaviour; " +
      "negative: user states they already know it or are not interested; " +
      "contextual: background context (job, project) rather than a learning goal"
    ),
  sourceMessageIndex: z
    .number()
    .int()
    .describe("0-based index of the source message in the conversation window (higher index = more recent)"),
});

/** A single learning signal extracted from the conversation by the Observer stage. */
export type ObservedSignal = z.infer<typeof observedSignalSchema>;

const observerSchema = z.object({
  rawSignals: z
    .array(observedSignalSchema)
    .describe("All learning signals extracted from the conversation, with structured metadata."),
});

let cachedObserverLLM: ReturnType<ChatOpenAI["withStructuredOutput"]> | null = null;

function getObserverLLM() {
  if (!cachedObserverLLM) {
    cachedObserverLLM = new ChatOpenAI({
      model: config.modelId,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      timeout: pipelineConfig.guards.timeoutMs,
    }).withStructuredOutput(observerSchema);
  }
  return cachedObserverLLM;
}

/** Extracts raw learning signals from the conversation log. */
export async function observeSignals(chatLog: string): Promise<ObservedSignal[]> {
  const llm = getObserverLLM();

  const response = await llm.invoke([
    new SystemMessage(config.systemPrompt),
    new HumanMessage(
      `[CONVERSATION LOG]:\n${chatLog}\n\n[TASK]: Extract all raw learning signals with structured metadata.`
    ),
  ]);

  return response?.rawSignals ?? [];
}
