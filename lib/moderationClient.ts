import { log } from "@/lib/logger";
import pipelineConfig from "@/agents/pipelineConfig.json";

export interface ModerationResult {
  flagged: boolean;
  categories: string[];
}

/**
 * Submits text to the OpenAI Moderation API and returns whether it was flagged.
 * Never throws — returns `{ flagged: false, categories: [] }` on any API failure.
 */
export async function callModerationAPI(text: string): Promise<ModerationResult> {
  try {
    // Timeout prevents hanging on OpenAI degradation.
    //  fail-open so a timeout never blocks messages.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), pipelineConfig.guards.timeoutMs);

    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ input: text }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      log({ level: "error", node: "moderationClient", message: `HTTP error ${response.status}` });
      return { flagged: false, categories: [] };
    }

    const data = await response.json();
    const result = data.results?.[0];
    if (!result) return { flagged: false, categories: [] };

    const firedCategories = Object.entries(result.categories as Record<string, boolean>)
      .filter(([, v]) => v)
      .map(([k]) => k);

    return { flagged: result.flagged, categories: firedCategories };
  } catch (err) {
    log({ level: "error", node: "moderationClient", message: "Unexpected error", error: String(err) });
    return { flagged: false, categories: [] };
  }
}
