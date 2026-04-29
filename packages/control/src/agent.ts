/**
 * @file agent.ts
 *
 * Claude CLI agent runner for the Studio Server.
 *
 * ## Responsibilities
 *
 *   - Resolve the repo root from SUPERFIELD_REPO_ROOT (or process.cwd()).
 *   - Load the optional changes.md context document for the session branch.
 *   - Build the full studio prompt from conversation history and mode.
 *   - Call POST /studio/run on the superfield API, collect the full SSE body.
 *
 * ## Integration points
 *
 *   - api.ts: handleControlRequest() calls runAgent() for POST /studio/chat.
 *   - helpers.ts: buildStudioPrompt() / buildQuestionModePrompt() construct
 *     the prompt string passed to Claude CLI.
 *   - permissions.ts: buildAllowedToolsFlag() determines which tools Claude
 *     may use in the given mode.
 *   - config.ts: SUPERFIELD_API_URL controls which API server receives runs.
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import {
  buildStudioPrompt,
  type ControlMessage,
  type ControlMode,
} from "./helpers";
import { buildQuestionModePrompt } from "./question-mode";
import { buildAllowedToolsFlag } from "./permissions";

export const REPO_ROOT = process.env.SUPERFIELD_REPO_ROOT ?? process.cwd();

export function resolveSuperfieldApiUrl(): string {
  return process.env.SUPERFIELD_API_URL ?? "http://127.0.0.1:7837";
}

/**
 * Collect the full text from a POST /studio/run SSE stream.
 *
 * Reads all `data:` lines (ignoring `event:` lines) and concatenates them.
 * Throws if an `event: error` frame is received.
 */
async function collectSseText(
  body: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice("event: ".length).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice("data: ".length);
        if (currentEvent === "error") {
          throw new Error(`Agent error: ${data}`);
        } else if (currentEvent === "session" || currentEvent === "done") {
          // Metadata frames — ignore text content.
        } else {
          text += data + "\n";
        }
        currentEvent = "";
      }
    }
  }

  return text;
}

/**
 * Invoke Claude CLI for one turn via POST /studio/run and return the full
 * stdout response as a string.
 *
 * @param messages  Full conversation history for the session.
 * @param branch    The current studio session branch name.
 * @param mode      Agent mode — 'design' (default) or 'question'.
 * @param _fetch    Dependency injection for fetch (tests can stub this).
 * @returns         Claude's trimmed response string.
 */
export async function runAgent(
  messages: ControlMessage[],
  branch: string,
  mode: ControlMode = "design",
  _fetch: typeof fetch = globalThis.fetch,
): Promise<string> {
  const changesPath = join(
    REPO_ROOT,
    `docs/studio-sessions/${branch}/changes.md`,
  );
  const changesContent = existsSync(changesPath)
    ? readFileSync(changesPath, "utf8")
    : undefined;

  const fullPrompt =
    mode === "question"
      ? buildQuestionModePrompt({
          branch,
          question: messages.at(-1)?.content ?? "",
        })
      : buildStudioPrompt({ branch, messages, changesContent, mode });

  const allowedTools = buildAllowedToolsFlag(mode);

  const res = await _fetch(`${resolveSuperfieldApiUrl()}/studio/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: fullPrompt,
      repoRoot: REPO_ROOT,
      allowedTools,
      mode,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`POST /studio/run failed: ${res.status}`);
  }

  const text = await collectSseText(res.body);
  return text.trim();
}
