// Following template to create new agent is from langchains docs: https://docs.langchain.com/oss/javascript/langchain/agents

// import { ChatOpenAI } from "@langchain/openai";
// import { createAgent } from "langchain";
// import { MemorySaver } from "@langchain/langgraph";
// import * as z from "zod";
// import agentConfig from "./agentConfig.json";

// const config = agentConfig.agents.generic; // changed from controller to generic
// const MODEL_ID = config.modelId;
// const TEMPERATURE = config.temperature;
// const systemPrompt = config.systemPrompt;

// const responseFormat = z.object({
//   reply: z.string().describe("Your response to the user"),
// });

// let cachedAgent: any = null;

// async function initialiseAgent() {
//   if (cachedAgent) return cachedAgent;

//   try {
//     const model = new ChatOpenAI({
//       model: MODEL_ID,
//       temperature: TEMPERATURE,
//     });

//     const checkpointer = new MemorySaver();

//     cachedAgent = createAgent({
//       model,
//       systemPrompt,
//       responseFormat,
//       checkpointer,
//     });

//     console.log("Generic agent initialised successfully");
//     return cachedAgent;
//   } catch (initError) {
//     console.error("Failed to initialize agent:", initError);
//     throw initError;
//   }
// }

// /**
//  * Handle an incoming conversation and optional context and return a plain text reply.
//  * @param messages - array of chat messages (e.g. [{role: 'user', content: '...'}])
//  * @param context - optional context object (may include user_id, thread_id, etc.)
//  */
// export async function handleMessage(
//   messages: Array<{ role: string; content: string }>,
//   context?: Record<string, any>,
// ): Promise<string> {
//   try {
//     const agent = await initialiseAgent();

//     const config = {
//       configurable: { thread_id: context?.thread_id ?? "default" },
//       context: { user_id: context?.user_id ?? "anonymous", ...(context ?? {}) },
//     };

//     console.log("Invoking agent with", messages.length, "messages");
//     const response = await agent.invoke({ messages }, config as any);
//     console.log("Agent response structure:", Object.keys(response));

//     // Prefer the structured response defined by the response format
//     if (response?.structuredResponse?.reply) {
//       const reply = String(response.structuredResponse.reply);
//       console.log("✓ Extracted reply from structuredResponse");
//       return reply;
//     }

//     if (response?.output) {
//       console.log("Checking output:", typeof response.output);
//       if (typeof response.output === "string") {
//         return response.output;
//       }
//       if (Array.isArray(response.output)) {
//         for (const item of response.output) {
//           if (item?.content) return String(item.content);
//           if (typeof item === "string") return item;
//         }
//       }
//     }

//     if (typeof response === "string") {
//       return response;
//     }

//     console.warn(
//       "Could not extract reply from response:",
//       JSON.stringify(response, null, 2),
//     );
//     return "Unable to generate a response. Please try again.";
//   } catch (error) {
//     console.error("genericAgent.handleMessage error:", error);
//     throw error;
//   }
// }

// export default handleMessage;
