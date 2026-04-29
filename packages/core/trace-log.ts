import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type TraceLevel = "error" | "warn" | "info" | "debug" | "trace";
export type TraceOrigin = "backend" | "browser";

export interface TraceLogEntry {
  readonly ts: string;
  readonly origin: TraceOrigin;
  readonly level: TraceLevel;
  readonly source: string;
  readonly message: string;
  readonly stack?: string;
  readonly context?: Record<string, unknown>;
}

function resolveTraceLogDir(logDir?: string): string {
  if (logDir?.trim()) return resolve(logDir);
  return resolve(process.env.CONTROL_LOG_DIR ?? "../studio-logs");
}

export function appendTraceLog(entry: TraceLogEntry, logDir?: string): void {
  const dir = resolveTraceLogDir(logDir);
  mkdirSync(dir, { recursive: true });
  const date = entry.ts.slice(0, 10);
  const filePath = join(dir, `${date}.traces.jsonl`);
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}
