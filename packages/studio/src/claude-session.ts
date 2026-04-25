/**
 * @file claude-session.ts
 *
 * Claude CLI session integration for the Studio Server.
 *
 * Canonical spec: docs/studio-mode.md — "Claude CLI Integration" and
 * "Logging" sections.
 *
 * ## Responsibilities
 *
 *   • Generate a session key once at startup and reuse it across all turns.
 *   • Invoke Claude CLI headlessly per turn:
 *       claude --dangerously-skip-permissions --session-key <key> -p <message>
 *   • Stream Claude stdout to the browser in real time via an SSE
 *     ReadableStream (see streamTurn).
 *   • Run the post-turn hook after each turn completes:
 *       1. git diff --name-only against the pre-turn HEAD
 *       2. Determine which cluster services are affected
 *       3. Trigger the hot-swap flow (stubbed; separate feature issue)
 *   • Append a JSONL log entry to STUDIO_LOG_DIR/YYYY-MM-DD.jsonl after
 *     each turn.
 *
 * ## Session key format
 *
 *   <timestamp-hex>-<random-hex-16>
 *
 *   e.g.  0196f4a2b3c1-a3f9d2e4b8c1f0a7
 *
 *   The timestamp component is the Unix epoch in milliseconds encoded as a
 *   zero-padded 12-character hex string, giving monotonically increasing keys
 *   that sort chronologically. The random component adds 64 bits of entropy.
 *
 * ## JSONL log entry schema
 *
 * ```json
 * {
 *   "timestamp": "2026-03-24T05:00:00.000Z",
 *   "message": "...",
 *   "response": "...",
 *   "filesChanged": ["apps/server/src/api.ts"],
 *   "servicesRestarted": ["api"],
 *   "restartDurationMs": 0
 * }
 * ```
 *
 * ## Integration points
 *
 *   - index.ts: call generateSessionKey() at startup and pass the key to
 *     ClaudeSession (or store it on the singleton ClaudeSession instance).
 *   - router.ts: wire GET /studio/chat/stream → streamTurn()
 *   - process-manager.ts: register the Claude subprocess with pm.register()
 *     so graceful shutdown sends SIGTERM to an in-flight Claude process.
 *   - hot-swap (separate issue): postTurnHook() calls triggerHotSwap() which
 *     is currently a no-op stub.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { buildAllowedToolsFlag } from './permissions';
import type { StudioMode } from './helpers';

// ── Configuration ─────────────────────────────────────────────────────────────

import { REPO_ROOT } from './agent';

/**
 * Resolve the log directory from STUDIO_LOG_DIR (defaults to ../studio-logs
 * relative to REPO_ROOT).
 */
function resolveLogDir(): string {
  const raw = process.env.STUDIO_LOG_DIR ?? '../studio-logs';
  // If it is an absolute path, use it directly. Otherwise resolve relative to
  // REPO_ROOT so the default of "../studio-logs" lands outside the git tree.
  return resolve(REPO_ROOT, raw);
}

// ── Session key generation ────────────────────────────────────────────────────

/**
 * Generate a stable, unique session key for a Claude CLI session.
 *
 * Format: <timestamp-hex-12>-<random-hex-16>
 *
 * The timestamp part is the Unix epoch in milliseconds encoded as a
 * zero-padded 12-character lowercase hex string (covers ~77 years from epoch).
 * The random part is 8 cryptographically random bytes encoded as hex.
 *
 * Example: "0196f4a2b3c1-a3f9d2e4b8c1f0a7"
 *
 * @returns A session key string suitable for the --session-key Claude CLI flag.
 */
export function generateSessionKey(): string {
  const nowHex = Date.now().toString(16).padStart(12, '0');
  const randBytes = crypto.getRandomValues(new Uint8Array(8));
  const randHex = Array.from(randBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${nowHex}-${randHex}`;
}

// ── JSONL logging ─────────────────────────────────────────────────────────────

export interface TurnLogEntry {
  /** ISO 8601 timestamp for this turn. */
  timestamp: string;
  /** The user message sent to Claude. */
  message: string;
  /** Claude's full response for this turn. */
  response: string;
  /** Files that changed (git diff --name-only) during this turn. */
  filesChanged: string[];
  /** Cluster services restarted by the hot-swap hook. */
  servicesRestarted: string[];
  /** Time taken for the hot-swap restart in milliseconds (0 when no restart). */
  restartDurationMs: number;
}

/**
 * Append a turn log entry to the daily JSONL log file.
 *
 * Log file path: <logDir>/YYYY-MM-DD.jsonl
 *
 * The directory is created if it does not exist. Each entry is a single JSON
 * line terminated by a newline — safe for concurrent append and line-by-line
 * streaming.
 */
export function appendTurnLog(entry: TurnLogEntry, logDir?: string): void {
  const dir = logDir ?? resolveLogDir();
  mkdirSync(dir, { recursive: true });

  const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD from entry timestamp
  const filePath = join(dir, `${date}.jsonl`);
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(filePath, line, 'utf8');
}

// ── Post-turn hook ────────────────────────────────────────────────────────────

/**
 * Snapshot the files changed since the given pre-turn HEAD commit.
 *
 * Runs: git diff --name-only <baseRef>
 *
 * @param baseRef  A git ref (commit hash, branch, etc.) to diff against.
 * @returns        Array of changed file paths relative to the repo root.
 */
export async function getChangedFiles(baseRef: string): Promise<string[]> {
  const repoRoot = process.env.CALYPSO_REPO_ROOT ?? REPO_ROOT;
  const proc = Bun.spawn(
    ['git', 'diff', '--name-only', baseRef],
    {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .trim()
    .split('\n')
    .filter(Boolean);
}

/**
 * Map changed file paths to the cluster services they belong to.
 *
 * File → service mapping:
 *   apps/server/**  → api
 *   apps/worker/**  → agents
 *   apps/web/**     → web
 *   packages/**     → api, agents (both depend on shared packages)
 *
 * @param files  Array of changed file paths (relative to repo root).
 * @returns      Deduplicated array of affected service names.
 */
export function detectAffectedServices(files: string[]): string[] {
  const services = new Set<string>();
  for (const file of files) {
    if (file.startsWith('apps/server/')) services.add('api');
    if (file.startsWith('apps/worker/')) services.add('agents');
    if (file.startsWith('apps/web/')) services.add('web');
    if (file.startsWith('packages/')) {
      services.add('api');
      services.add('agents');
    }
  }
  return Array.from(services);
}

/**
 * Trigger the hot-swap flow for the given services.
 *
 * This is a stub implementation. The actual hot-swap build and pod cycling
 * logic is implemented in a separate feature issue. This stub captures the
 * interface and returns the duration (always 0 ms until the real
 * implementation is wired in).
 *
 * @param services  Service names to hot-swap.
 * @returns         Duration in milliseconds (always 0 in stub).
 */
export async function triggerHotSwap(services: string[]): Promise<number> {
  if (services.length === 0) return 0;
  // Stub: real hot-swap is implemented in hot-swap.ts and wired by a separate issue.
  console.log(`[studio] hot-swap stub: would restart services: ${services.join(', ')}`);
  return 0;
}

/**
 * Post-turn hook — runs synchronously after each Claude turn completes.
 *
 * 1. Snapshots git diff --name-only against preRef.
 * 2. Determines which cluster services are affected.
 * 3. Triggers the hot-swap flow (stub; blocks until complete or failed).
 *
 * Per spec: "The hook runs synchronously — Claude's next turn does not begin
 * until the hot-swap completes (or fails)."
 *
 * @param preRef  git ref representing the state before the turn (HEAD before
 *                claude was invoked, captured by the caller).
 * @returns       Post-turn context used for log entry construction.
 */
export async function postTurnHook(preRef: string): Promise<{
  filesChanged: string[];
  servicesRestarted: string[];
  restartDurationMs: number;
}> {
  const filesChanged = await getChangedFiles(preRef);
  const affectedServices = detectAffectedServices(filesChanged);
  const restartDurationMs = await triggerHotSwap(affectedServices);

  return {
    filesChanged,
    servicesRestarted: affectedServices,
    restartDurationMs,
  };
}

// ── Pre-turn HEAD snapshot ────────────────────────────────────────────────────

/**
 * Capture the current HEAD commit hash before a turn starts.
 *
 * This ref is passed to postTurnHook() so it can diff against the pre-turn
 * state, not the current HEAD (which may include Claude's commits).
 *
 * @returns Full commit hash string, or 'HEAD' as a safe fallback.
 */
export async function capturePreTurnRef(): Promise<string> {
  const repoRoot = REPO_ROOT;
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const hash = text.trim();
  return hash || 'HEAD';
}

// ── SSE streaming ─────────────────────────────────────────────────────────────

/**
 * Invoke Claude CLI for one turn and stream its stdout via a ReadableStream
 * suitable for use as a Server-Sent Events response body.
 *
 * Claude is invoked as:
 *   claude --dangerously-skip-permissions --session-key <key> -p <message>
 *
 * Each chunk of stdout is encoded as an SSE event:
 *   data: <chunk>\n\n
 *
 * A final "done" event signals turn completion:
 *   event: done\ndata: \n\n
 *
 * If Claude exits with a non-zero code the stream emits an error event:
 *   event: error\ndata: <message>\n\n
 *
 * The post-turn hook and JSONL log are written after the subprocess exits,
 * before the "done" event is emitted.
 *
 * @param message     The user message for this turn.
 * @param sessionKey  The persistent session key (generated at startup).
 * @param logDir      Optional log directory override (for tests).
 * @returns           A ReadableStream of SSE-formatted bytes.
 */
export function streamTurn(
  message: string,
  sessionKey: string,
  logDir?: string,
  mode: StudioMode = 'design',
  _fetch: typeof fetch = globalThis.fetch,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  function sseEvent(data: string, eventName?: string): Uint8Array {
    const eventLine = eventName ? `event: ${eventName}\n` : '';
    return encoder.encode(`${eventLine}data: ${data}\n\n`);
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let response = '';
      let preRef = 'HEAD';
      let capturedSessionId = sessionKey;

      try {
        preRef = await capturePreTurnRef();
      } catch {
        // Non-fatal — use HEAD as fallback.
      }

      const repoRoot = process.env.CALYPSO_REPO_ROOT ?? REPO_ROOT;
      const superfieldApiUrl = process.env.SUPERFIELD_API_URL ?? 'http://127.0.0.1:7837';
      const allowedToolsFlag = buildAllowedToolsFlag(mode);

      let apiRes: Response;
      try {
        apiRes = await _fetch(`${superfieldApiUrl}/studio/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            repoRoot,
            sessionKey,
            allowedTools: allowedToolsFlag,
            mode,
          }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseEvent(msg, 'error'));
        controller.close();
        return;
      }

      if (!apiRes.ok || !apiRes.body) {
        controller.enqueue(sseEvent(`Superfield API unavailable: HTTP ${apiRes.status}`, 'error'));
        controller.close();
        return;
      }

      // Parse SSE frames from the API and forward to the browser.
      const reader = apiRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice('event: '.length).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice('data: '.length);
            if (currentEvent === 'session') {
              // Capture the sessionId for later use.
              try {
                const parsed = JSON.parse(data) as { sessionId?: string };
                if (parsed.sessionId) capturedSessionId = parsed.sessionId;
              } catch { /* ignore parse errors */ }
              currentEvent = '';
            } else if (currentEvent === 'error') {
              controller.enqueue(sseEvent(data, 'error'));
              controller.close();
              return;
            } else if (currentEvent === 'done') {
              // Don't forward the API's done — we emit our own after post-turn hook.
              currentEvent = '';
            } else {
              // Plain data chunk — forward to browser and accumulate.
              response += data + '\n';
              controller.enqueue(sseEvent(data));
              currentEvent = '';
            }
          }
        }
      }

      void capturedSessionId; // consumed above for session tracking

      // Post-turn hook: git diff, service detection, hot-swap.
      let filesChanged: string[] = [];
      let servicesRestarted: string[] = [];
      let restartDurationMs = 0;

      try {
        const hookResult = await postTurnHook(preRef);
        filesChanged = hookResult.filesChanged;
        servicesRestarted = hookResult.servicesRestarted;
        restartDurationMs = hookResult.restartDurationMs;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[studio] post-turn hook error:', msg);
      }

      // Append JSONL log entry.
      try {
        appendTurnLog(
          {
            timestamp: new Date().toISOString(),
            message,
            response: response.trim(),
            filesChanged,
            servicesRestarted,
            restartDurationMs,
          },
          logDir,
        );
      } catch (err) {
        console.error('[studio] JSONL log error:', err);
      }

      // Signal turn completion.
      controller.enqueue(sseEvent('', 'done'));
      controller.close();
    },

    cancel() {
      // The browser disconnected before the turn completed.
      // In-flight fetch request will be garbage-collected.
    },
  });
}

// ── Singleton session ─────────────────────────────────────────────────────────

/**
 * Module-level session key, generated once at import time.
 *
 * The studio server is single-user by design. One session key covers the
 * entire lifetime of the server process. When the server stops and restarts,
 * a new session key is generated — there is no cross-restart continuity.
 */
export const SESSION_KEY: string = generateSessionKey();
