import { Redis } from "@upstash/redis";
import { log } from "@/lib/logger";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  log({ level: "warn", node: "redis", message: "UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set — Redis caching is disabled" });
}

/** Upstash Redis singleton. Null when env vars are absent*/
export const redis: Redis | null =
  url && token ? new Redis({ url, token }) : null;
