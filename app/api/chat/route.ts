import { handleMessage } from "../../../agents/controllerAgent";
import { adminAuth } from "@/lib/firebaseAdmin";
import { checkRateLimit } from "@/lib/rateLimiter";
import { log } from "@/lib/logger";

/** SSE chat endpoint: authenticates, rate-limits, and streams the agent pipeline output to the client. */
export async function POST(req: Request) {
  const requestId = crypto.randomUUID();
  try {
    if (!process.env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Verify Firebase ID token: use decoded.uid as the trusted userId.
    // Unauthenticated requests (no header) are allowed for the anonymous-user flow.
    let verifiedUserId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        const decoded = await adminAuth.verifyIdToken(token);
        verifiedUserId = decoded.uid;
      } catch {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Rate limiting checked after auth (needs verifiedUserId) but before body parsing.
    const rateLimit = await checkRateLimit(verifiedUserId);
    if (!rateLimit.allowed) {
      const retryAfterSec = Math.ceil((rateLimit.retryAfterMs ?? 60_000) / 1000);
      return new Response(
        JSON.stringify({ error: "Too many requests. Please wait before sending another message." }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfterSec),
          },
        }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || !body.messages) {
      return new Response(
        JSON.stringify({ error: "Invalid request: missing messages" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { messages, data } = body;

    const stream = await handleMessage(
      messages,
      { context: data?.context ?? undefined, userId: verifiedUserId ?? undefined, requestId }
    );

    return new Response(stream, {
      status: 200,
      headers: {
        // Cache-Control / X-Accel-Buffering prevent proxy buffering that would batch SSE frames.
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    log({ level: "error", node: "chatRoute", requestId, message: "Chat API Error", error: String(error) });

    return new Response(
      JSON.stringify({
        error: "Failed to process chat request",
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
