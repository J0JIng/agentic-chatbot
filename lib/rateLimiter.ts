import { redis } from "@/lib/redis";
import { log } from "@/lib/logger";
import pipelineConfig from "@/agents/pipelineConfig.json";

const { windowS: WINDOW_S, maxAuthed: MAX_AUTHED, maxAnon: MAX_ANON } = pipelineConfig.rateLimit;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

/** Checks whether the request is within the allowed rate limit window. */
export async function checkRateLimit(
  userId: string | null
): Promise<RateLimitResult> {
  if (!redis) return { allowed: true };

  const key   = `chatbot:rl:${userId || "anon"}`;
  const limit = userId ? MAX_AUTHED : MAX_ANON;

  try {
    const count = await redis.incr(key);

    if (count === 1) {
      // EXPIRE only on count === 1 to keep the window boundary fixed, not sliding.
      await redis.expire(key, WINDOW_S);
    }

    if (count > limit) {
      const ttl = await redis.ttl(key);
      return {
        allowed: false,
        retryAfterMs: Math.max(ttl, 0) * 1000,
      };
    }

    return { allowed: true };
  } catch (err) {
    log({ level: "warn", node: "rateLimiter", message: "Redis error, failing open", error: String(err) });
    return { allowed: true };
  }
}
