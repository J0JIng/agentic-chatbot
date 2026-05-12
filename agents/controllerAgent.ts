import { waitUntil } from "@vercel/functions";
import { validateInput } from "./inputGuardAgent";
import { analyseAndProfileUser } from "./userProfilingAgent";
import { buildEffectiveUserProfile } from "@/lib/userProfileService";
import { getChatGraph, classifyIntent } from "./chatGraph";
import { isCircuitOpen, recordFailure, recordSuccess } from "@/lib/circuitBreaker";
import { log } from "@/lib/logger";
import pipelineConfig from "@/agents/pipelineConfig.json";

const _sseEncoder = new TextEncoder();

/** Encode a typed SSE frame: `event: <type>\ndata: <JSON>\n\n` */
function sseEvent(type: string, data: Record<string, any>): Uint8Array {
  return _sseEncoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Returns the length of the longest suffix of `text` that is also a prefix of `tag`.
 * Used to hold back the tail of `pendingBuffer` when a tag may be split across chunks.
 *
 * e.g. longestTagPrefix("Hello <th", "<thought>") → 3  (keeps "<th" for next chunk)
 *      longestTagPrefix("Hello",     "<thought>") → 0  (no partial match)
 */
function longestTagPrefix(text: string, tag: string): number {
  const maxLen = Math.min(text.length, tag.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (tag.startsWith(text.slice(-len))) return len;
  }
  return 0;
}

/** Main text served when the circuit is OPEN (OpenAI is unhealthy). */
const CB_FALLBACK_TEXT =
  "I'm having trouble connecting to my AI reasoning engine right now — " +
  "this is usually resolved within a minute. Please try again shortly, " +
  "or explore our courses directly.";

const CB_FALLBACK_FOLLOWUPS = [
  "What courses are available?",
  "How does the platform work?",
  "Show me popular courses",
];

/**
 * Returns true for errors that should trip the circuit breaker.
 *
 * Exclusions:
 *   FirebaseError — Firestore is unrelated to OpenAI health.
 *   HTTP 429     — rate-limit, not an outage; circuit stays closed so requests retry later.
 */
function isOpenAIError(error: any): boolean {
  if (error?.name === "FirebaseError") return false;
  if (error?.status === 429) return false;
  return true;
}

/**
 * Parses a structured `responseText` (from recommenderNode / comparerNode /
 * learningPathNode) into typed SSE events and returns the clean intro text
 * (stripped of all tags) for downstream profiling.
 *
 * Emit order: thought → recommendation_meta → token (intro) → course_card × n → follow_up
 *
 * @param responseText - Raw structured response text from a specialist node.
 * @param controller - The ReadableStream controller to enqueue events into.
 * @param requestId - Optional request ID for log correlation.
 * @returns Clean intro text for profiling (no thought/meta/card/follow_up tags).
 */
function parseAndEmitStructuredResponse(
  responseText: string,
  controller: ReadableStreamDefaultController<any>,
  requestId?: string
): string {
  let text = responseText;

  const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/g;
  let thoughtMatch: RegExpExecArray | null;
  while ((thoughtMatch = thoughtRegex.exec(responseText)) !== null) {
    const trimmedThought = thoughtMatch[1].trim();
    if (trimmedThought) {
      controller.enqueue(sseEvent("thought", { content: trimmedThought }));
    }
  }
  text = text.replace(/<thought>[\s\S]*?<\/thought>/g, "").trim();

  const metaRegex = /\[RECOMMENDATION_META\]([\s\S]*?)\[\/RECOMMENDATION_META\]/;
  const metaMatch = text.match(metaRegex);
  if (metaMatch) {
    try {
      controller.enqueue(sseEvent("recommendation_meta", JSON.parse(metaMatch[1])));
    } catch {
      // Malformed meta — silently skip
    }
  }
  text = text.replace(/\[RECOMMENDATION_META\][\s\S]*?\[\/RECOMMENDATION_META\]/g, "").trim();

  // [FOLLOW_UP] extracted after cards to preserve render order: intro text → course cards → follow-up suggestions
  let followUpQuestions: string[] = [];
  if (text.includes("[FOLLOW_UP]:")) {
    const [beforeFollowUp, followUpRaw] = text.split("[FOLLOW_UP]:");
    text = beforeFollowUp.trim();
    followUpQuestions = (followUpRaw ?? "")
      .split("|")
      .map((q) => q.trim())
      .filter((q) => q.length > 0);
  }

  // Walk segments between card boundaries so inter-card text is not silently discarded.
  const segments = text.split(/\[COURSE_CARD\][\s\S]*?\[\/COURSE_CARD\]/g);
  const introText = segments[0].trim();
  if (introText) {
    controller.enqueue(sseEvent("token", { content: introText }));
  }

  const courseCardRegex = /\[COURSE_CARD\]([\s\S]*?)\[\/COURSE_CARD\]/g;
  let cardMatch: RegExpExecArray | null;
  let cardIdx = 0;
  while ((cardMatch = courseCardRegex.exec(text)) !== null) {
    try {
      controller.enqueue(sseEvent("course_card", JSON.parse(cardMatch[1])));
    } catch (e) {
      log({ level: "error", node: "controllerNode", requestId, message: "Course card parse error", error: String(e) });
    }
    cardIdx++;
    const interCardText = segments[cardIdx]?.trim();
    if (interCardText) {
      controller.enqueue(sseEvent("section_header", { content: interCardText }));
    }
  }

  if (followUpQuestions.length > 0) {
    controller.enqueue(sseEvent("follow_up", { questions: followUpQuestions }));
  }

  return introText;
}

/**
 * Drives the 6-node StateGraph, runs the circuit breaker check, and returns a ReadableStream of typed SSE events.
 *
 * SSE event taxonomy:
 *   token              — natural-language text chunk (streaming, 1+ per response)
 *   thought            — reasoning trace (buffered from <thought>…</thought> blocks)
 *   course_card        — single course object (structured intents only)
 *   follow_up          — array of suggested follow-up questions
 *   recommendation_meta — scoring/signal metadata (consumed silently by client)
 *   block              — safety block (terminates stream)
 *   hallucination_warning — high-risk output flag
 *   done               — stream complete sentinel
 *
 * Speculative pre-graph execution: Promise.all([buildEffectiveUserProfile(), validateInput(), classifyIntent()])
 * runs in parallel before graph.streamEvents(). Circuit check runs first; speculative block is skipped when circuit is open.
 */
export async function handleMessage(
  messages: Array<{ role: string; content: string }>,
  context?: Record<string, any>
): Promise<ReadableStream> {
  const userMessage = messages[messages.length - 1]?.content || "";

  const requestId = context?.requestId as string | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Short-circuit when the circuit is OPEN to skip speculative LLM calls
        if (await isCircuitOpen()) {
          log({ level: "warn", node: "controllerNode", requestId, userId: context?.userId, message: "Circuit OPEN — serving fallback response" });
          controller.enqueue(sseEvent("token", { content: CB_FALLBACK_TEXT }));
          controller.enqueue(sseEvent("follow_up", { questions: CB_FALLBACK_FOLLOWUPS }));
          controller.enqueue(sseEvent("done", {}));
          controller.close();
          return;
        }

        // classifyIntent() runs outside graph.streamEvents() to prevent its structured-output JSON from entering the stream.
        const [profile, validation, classification] = await Promise.all([
          buildEffectiveUserProfile(context?.userId ?? ""),
          validateInput(userMessage),
          classifyIntent(userMessage, messages),
        ]);

        if (!validation.isValid) {
          controller.enqueue(sseEvent("block", { reason: validation.reason }));
          controller.enqueue(sseEvent("done", {}));
          controller.close();
          return;
        }

        const graph = getChatGraph();
        const graphConfig = {
          configurable: { thread_id: context?.userId ?? crypto.randomUUID() },
        };

        const initialState = {
          userMessage,
          userId: context?.userId ?? "",
          profile,
          messages,
          contextText: context?.context,
          isValid: true,
          blockReason: "",
          // Pre-classified intent passed through so controllerNode skips its own classifier call
          intent: classification.intent,
          searchQuery: classification.searchQuery,
          secondaryQuery: classification.secondaryQuery ?? "",
        };

        let fullResponse = "";
        let finalGraphState: any = null;
        let isHandlingTool = false;
        // Rolling buffer for cross-chunk tag detection.
        // Holds back the tail of pendingBuffer when a tag may be split across chunks.
        let jsonLeakBuffer = "";
        let jsonLeakDepth = 0;
        let graphSucceeded = false;

        let pendingBuffer = "";   // accumulates chunks; tail may be a partial tag
        let inThought = false;
        let thoughtBuffer = "";
        let inFollowUp = false;   // true once [FOLLOW_UP]: is seen in a streaming intent
        let followUpBuffer = "";  // accumulates follow-up text after [FOLLOW_UP]:

        // Inner try/catch isolates graph/LLM errors from outer infrastructure errors.
        // On graph failure the circuit breaker records a failure and serves the fallback.
        try {
          // — on_chat_model_stream events from controllerNode's response LLM call are automatically propagated here via LangChain's callback system.
          // — Recommendation output (COURSE_CARDs) arrives in finalGraphState after graph ends.
          for await (const event of graph.streamEvents(initialState, {
            ...graphConfig,
            version: "v2",
          })) {
            if (
              event.event === "on_chat_model_stream" &&
              event.metadata?.langgraph_node === "controllerNode"
            ) {
              const chunk = event.data.chunk;

              if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
                isHandlingTool = true;
                continue;
              }

              // Reset once content resumes after a tool call sequence.
              // Tool calls and content generation are separate LLM invocations in LangGraph,
              // so the first content chunk of the post-tool continuation resets the flag.
              if (chunk.content) {
                isHandlingTool = false;
              }

              if (!isHandlingTool && chunk.content) {
                const chunkText: string = chunk.content;

                // JSON leak filter
                if (fullResponse.length === 0 || jsonLeakBuffer.length > 0) {
                  const startsJson =
                    jsonLeakBuffer.length === 0 &&
                    chunkText.trimStart().startsWith("{");

                  if (startsJson || jsonLeakBuffer.length > 0) {
                    jsonLeakBuffer += chunkText;
                    // Guard against unbounded buffer growth (e.g. a model that never closes a brace). 
                    // Reset and flush if buffer exceeds 10 KB as it cannot be a valid classifier JSON object.
                    if (jsonLeakBuffer.length > pipelineConfig.streaming.jsonLeakBufferCap) {
                      fullResponse += jsonLeakBuffer;
                      controller.enqueue(sseEvent("token", { content: jsonLeakBuffer }));
                      jsonLeakBuffer = "";
                      jsonLeakDepth = 0;
                      continue;
                    }
                    for (const ch of chunkText) {
                      if (ch === "{") jsonLeakDepth++;
                      if (ch === "}") jsonLeakDepth--;
                    }

                    if (jsonLeakDepth <= 0 && jsonLeakBuffer.length > 0) {
                      // JSON object complete. Discard if it looks like the classifier output, otherwise flush it to the stream.
                      const isClassifierJson =
                        jsonLeakBuffer.includes('"intent"') &&
                        jsonLeakBuffer.includes('"searchQuery"');
                      if (!isClassifierJson) {
                        fullResponse += jsonLeakBuffer;
                        controller.enqueue(sseEvent("token", { content: jsonLeakBuffer }));
                      }
                      jsonLeakBuffer = "";
                      jsonLeakDepth = 0;
                    }
                    continue;
                  }
                }
                // Narrow filter: only drop LangChain-specific tool-call artifacts.
                const isToolArtifact =
                  chunkText.includes('{"input":') ||
                  chunkText.includes("functions.");

                if (isToolArtifact) continue;

                // pendingBuffer state machine: handles cross-chunk <thought>, </thought>, and
                // [FOLLOW_UP]: tags. Safe bytes are flushed to the client immediately;
                // the tail (up to max partial-tag length) is held back for the next chunk.
                pendingBuffer += chunkText;

                while (pendingBuffer.length > 0) {
                  if (inFollowUp) {
                    // Everything from here on belongs to the follow-up list.
                    followUpBuffer += pendingBuffer;
                    pendingBuffer = "";
                    break;
                  }

                  if (inThought) {
                    const closeIdx = pendingBuffer.indexOf("</thought>");
                    if (closeIdx >= 0) {
                      thoughtBuffer += pendingBuffer.slice(0, closeIdx);
                      const trimmedThought = thoughtBuffer.trim();
                      if (trimmedThought) {
                        controller.enqueue(sseEvent("thought", { content: trimmedThought }));
                      }
                      thoughtBuffer = "";
                      inThought = false;
                      pendingBuffer = pendingBuffer.slice(closeIdx + "</thought>".length);
                    } else {
                      // Hold back a tail that might be a partial </thought>
                      const partial = longestTagPrefix(pendingBuffer, "</thought>");
                      thoughtBuffer += pendingBuffer.slice(0, pendingBuffer.length - partial);
                      pendingBuffer = pendingBuffer.slice(pendingBuffer.length - partial);
                      break;
                    }
                    continue;
                  }

                  // Neither in thought nor follow-up: scan for earliest watched tag
                  const thoughtOpenIdx = pendingBuffer.indexOf("<thought>");
                  const followUpIdx = pendingBuffer.indexOf("[FOLLOW_UP]:");
                  const firstIdx =
                    thoughtOpenIdx >= 0 && (followUpIdx < 0 || thoughtOpenIdx <= followUpIdx)
                      ? thoughtOpenIdx
                      : followUpIdx;

                  if (firstIdx >= 0) {
                    // Flush safe bytes before the tag
                    const before = pendingBuffer.slice(0, firstIdx);
                    if (before) {
                      fullResponse += before;
                      controller.enqueue(sseEvent("token", { content: before }));
                    }
                    if (pendingBuffer[firstIdx] === "<") {
                      // Opening <thought>
                      inThought = true;
                      pendingBuffer = pendingBuffer.slice(firstIdx + "<thought>".length);
                    } else {
                      // [FOLLOW_UP]:
                      inFollowUp = true;
                      pendingBuffer = pendingBuffer.slice(firstIdx + "[FOLLOW_UP]:".length);
                    }
                    // continue re-enter loop with remainder
                  } else {
                    // No complete tag found. hold back potential partial-tag tail
                    const keepBack = Math.max(
                      longestTagPrefix(pendingBuffer, "<thought>"),
                      longestTagPrefix(pendingBuffer, "[FOLLOW_UP]:")
                    );
                    const safe = pendingBuffer.slice(0, pendingBuffer.length - keepBack);
                    if (safe) {
                      fullResponse += safe;
                      controller.enqueue(sseEvent("token", { content: safe }));
                    }
                    pendingBuffer = pendingBuffer.slice(pendingBuffer.length - keepBack);
                    break;
                  }
                }
              }
            }

            // Capture final graph state (contains recommendation output + output guard results).
            if (
              event.event === "on_chain_end" &&
              event.data?.output &&
              typeof event.data.output === "object" &&
              "intent" in event.data.output
            ) {
              finalGraphState = event.data.output;
            }
          }

          if (pendingBuffer && !inThought && !inFollowUp) {
            fullResponse += pendingBuffer;
            controller.enqueue(sseEvent("token", { content: pendingBuffer }));
            pendingBuffer = "";
          }

          // Flush incomplete thought buffer if stream ends mid-thought
          const pendingThought = (thoughtBuffer + pendingBuffer).trim();
          if (inThought && pendingThought) {
            controller.enqueue(sseEvent("thought", { content: pendingThought }));
            thoughtBuffer = "";
            inThought = false;
            pendingBuffer = "";
          }

          // [FOLLOW_UP] emitted here for faq/general; structured intents use parseAndEmitStructuredResponse
          const rawFollowUp = (followUpBuffer + (inFollowUp ? pendingBuffer : "")).trim();
          if (rawFollowUp) {
            const questions = rawFollowUp
              .split("|")
              .map((q) => q.trim().replace(/^[\d.\-\*\)]+\s*/, ""))
              .filter((q) => q.length > 0);
            if (questions.length > 0) {
              controller.enqueue(sseEvent("follow_up", { questions }));
            }
          }

          // Emit structured-node output; faq/general was already streamed token-by-token above
          const structuredIntents = ["recommendation", "comparison", "learning_path"];
          if (structuredIntents.includes(finalGraphState?.intent) && finalGraphState?.responseText) {
            fullResponse = parseAndEmitStructuredResponse(
              finalGraphState.responseText,
              controller,
              requestId
            );
          }

          // Use strict `=== false` so outputSafe:undefined is not treated as unsafe
          if (finalGraphState && finalGraphState.outputSafe === false) {
            controller.enqueue(
              sseEvent("block", {
                reason: finalGraphState.outputSafetyReasons?.join(", ") || "Safety Violation",
              })
            );
          } else if (finalGraphState?.outputHallucinationRisk === "high") {
            controller.enqueue(sseEvent("hallucination_warning", {}));
          }

          graphSucceeded = true;
        } catch (graphError: any) {
          log({ level: "error", node: "controllerNode", requestId, userId: context?.userId, message: "Graph/LLM error", error: String(graphError) });
          if (isOpenAIError(graphError)) {
            await recordFailure();
          }
          controller.enqueue(sseEvent("token", { content: CB_FALLBACK_TEXT }));
          controller.enqueue(sseEvent("follow_up", { questions: CB_FALLBACK_FOLLOWUPS }));
        }

        if (graphSucceeded) {
          await recordSuccess();
        }

        // Background profiling — strip <thought> blocks so only user-facing text is passed.
        // Runs only on successful graph execution; skipped on fallback.
        if (graphSucceeded && fullResponse) {
          const profilingContent = fullResponse
            .replace(/<thought>[\s\S]*?<\/thought>/g, "")
            .trim();
          // Truncate history to avoid exceeding the observer token limit
          waitUntil(
            analyseAndProfileUser(context?.userId ?? "", [
              ...messages.slice(-pipelineConfig.profiling.messageWindowDepth),
              { role: "assistant", content: profilingContent },
            ]).catch((e) => log({ level: "error", node: "profilingPipeline", requestId, userId: context?.userId, message: "Profiling failed", error: String(e) }))
          );
        }

        // Always emit done so the client detects stream end
        controller.enqueue(sseEvent("done", {}));
        controller.close();
      } catch (error: any) {
        log({ level: "error", node: "controllerNode", requestId, message: "Controller stream error", error: String(error) });
        controller.enqueue(sseEvent("token", { content: CB_FALLBACK_TEXT }));
        controller.enqueue(sseEvent("follow_up", { questions: CB_FALLBACK_FOLLOWUPS }));
        controller.enqueue(sseEvent("done", {}));
        controller.close();
      }
    },
  });

  return stream;
}
