/**
 * @file turns.ts
 *
 * Turn-timeline endpoint (D6 / C-9.6).
 *
 *   GET /studio/turns/:sessionId
 *
 * Reads JSONL turn logs from <CONTROL_LOG_DIR>/*.jsonl, filters by sessionId,
 * and returns a summarised array of `{ ts, durationMs, tokens, costUsd,
 * exitStatus, prompt, response }` shaped entries. Missing fields fall back
 * to safe defaults so the demo seed (which only emits a subset) renders.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { errorResponse } from "../lib/error-envelope";
import { logBackendError } from "./debug-events";
import { REPO_ROOT } from "./agent";

export interface TurnSummary {
  readonly ts: string;
  readonly durationMs: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly exitStatus: string;
  readonly prompt: string;
  readonly response: string;
  readonly filesChanged?: readonly string[];
  readonly servicesRestarted?: readonly string[];
}

interface RawTurn {
  readonly timestamp?: string;
  readonly ts?: string;
  readonly message?: string;
  readonly prompt?: string;
  readonly response?: string;
  readonly sessionId?: string;
  readonly durationMs?: number;
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly exitStatus?: string;
  readonly restartDurationMs?: number;
  readonly filesChanged?: readonly string[];
  readonly servicesRestarted?: readonly string[];
}

function logDirPath(): string {
  const raw = process.env.CONTROL_LOG_DIR ?? "../studio-logs";
  return resolve(REPO_ROOT, raw);
}

function summarise(raw: RawTurn): TurnSummary {
  return {
    ts: raw.ts ?? raw.timestamp ?? new Date(0).toISOString(),
    durationMs: raw.durationMs ?? raw.restartDurationMs ?? 0,
    tokens: raw.tokens ?? 0,
    costUsd: raw.costUsd ?? 0,
    exitStatus: raw.exitStatus ?? "ok",
    prompt: raw.prompt ?? raw.message ?? "",
    response: raw.response ?? "",
    filesChanged: raw.filesChanged,
    servicesRestarted: raw.servicesRestarted,
  };
}

/** GET /studio/turns/:sessionId */
function handleTurns(sessionId: string): Response {
  const dir = logDirPath();
  if (!existsSync(dir)) {
    return jsonOk({ sessionId, turns: [] });
  }
  const turns: TurnSummary[] = [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const raw = readFileSync(join(dir, file), "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: RawTurn;
        try {
          parsed = JSON.parse(trimmed) as RawTurn;
        } catch {
          continue;
        }
        if (parsed.sessionId !== sessionId) continue;
        turns.push(summarise(parsed));
      }
    }
  } catch (err) {
    logBackendError(err, `GET /studio/turns/${sessionId}`);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse({
      code: "server",
      message: `Failed to read turn logs: ${message}`,
      hint: "Verify CONTROL_LOG_DIR is readable and contains *.jsonl files.",
    });
  }
  turns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return jsonOk({ sessionId, turns });
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Top-level turns route handler. Returns null when the request does not
 * belong to /studio/turns/* so the router can fall through.
 */
export function handleTurnsRequest(req: Request, url: URL): Response | null {
  const { pathname } = url;
  if (req.method !== "GET") return null;
  const m = pathname.match(/^\/studio\/turns\/([^/]+)$/);
  if (!m?.[1]) return null;
  return handleTurns(decodeURIComponent(m[1]));
}
