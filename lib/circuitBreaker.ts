import { redis } from "@/lib/redis";
import { log } from "@/lib/logger";
import pipelineConfig from "@/agents/pipelineConfig.json";

const { threshold: THRESHOLD, windowS: WINDOW_S, openDurationS: OPEN_DURATION_S } = pipelineConfig.circuitBreaker;

const CB_FAILURES_KEY   = "chatbot:cb:failures";
const CB_OPEN_UNTIL_KEY = "chatbot:cb:open_until";

let _failures    = 0;
let _windowStart = 0;
let _openUntil   = 0;   // 0 = circuit closed (CLOSED state)

/** Returns true when the circuit is OPEN. Callers should skip LLM calls and serve a pre-built fallback response. */
export async function isCircuitOpen(): Promise<boolean> {
  if (redis) {
    try {
      const openUntil = await redis.get<number>(CB_OPEN_UNTIL_KEY);
      // Key absent or TTL expired → circuit closed
      return openUntil != null && Date.now() < openUntil;
    } catch {
      // fall through to in-process state
    }
  }

  if (_openUntil > 0) {
    if (Date.now() < _openUntil) return true;
    _openUntil   = 0;
    _failures    = 0;
    _windowStart = 0;
  }
  return false;
}

/**
 * Increments the failure counter. Opens the circuit when THRESHOLD is reached.
 * Call this after a confirmed LLM / OpenAI API failure.
 */
export async function recordFailure(): Promise<void> {
  if (redis) {
    try {
      const count = await redis.incr(CB_FAILURES_KEY);
      if (count === 1) {
        // EXPIRE only on count === 1 to keep the window boundary fixed, not sliding.
        await redis.expire(CB_FAILURES_KEY, WINDOW_S);
      }
      if (count >= THRESHOLD) {
        const openUntilMs = Date.now() + OPEN_DURATION_S * 1_000;
        await redis.set(CB_OPEN_UNTIL_KEY, openUntilMs, { ex: OPEN_DURATION_S });
        log({ level: "warn", node: "circuitBreaker", message: `OPENED — ${count} LLM failures in ${WINDOW_S}s window. Serving fallback for ${OPEN_DURATION_S}s` });
      }
      return;
    } catch {
      // fall through to in-process
    }
  }

  const now = Date.now();
  if (_windowStart === 0 || now - _windowStart > WINDOW_S * 1_000) {
    _failures    = 0;
    _windowStart = now;
  }
  _failures++;
  if (_failures >= THRESHOLD) {
    _openUntil = now + OPEN_DURATION_S * 1_000;
    log({ level: "warn", node: "circuitBreaker", message: `OPENED (in-process) — ${_failures} failures. Serving fallback for ${OPEN_DURATION_S}s` });
  }
}

/**
 * Clears the failure counter after a successful LLM call.
 * Does NOT force-close the circuit if currently open — the OPEN_DURATION_S
 * TTL handles that automatically. Clearing the failure tally ensures that a
 * healthy request window after recovery starts from zero rather than from a
 * stale count that could immediately re-trip the breaker.
 */
export async function recordSuccess(): Promise<void> {
  if (redis) {
    try {
      await redis.del(CB_FAILURES_KEY);
    } catch {
      // fall through to in-process
    }
  }
  _failures    = 0;
  _windowStart = 0;
}
