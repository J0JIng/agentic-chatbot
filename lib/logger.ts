type LogLevel = "info" | "warn" | "error";

export interface StructuredLog {
  level: LogLevel;
  requestId?: string;
  userId?: string;
  node?: string;
  intent?: string;
  latencyMs?: number;
  isValid?: boolean;
  isSafe?: boolean;
  message?: string;
  error?: string;
}

/** Emits a structured JSON log line captured by Vercel's log runtime. */
export function log(entry: StructuredLog): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}
