/**
 * @file api.ts
 *
 * Studio API request handler.
 *
 * Handles all routes under /studio/* that are not SSE streams or rebuilds.
 * All routes require a valid JWT session cookie (enforced at the top of
 * handleControlRequest before any route is dispatched).
 *
 * ## Route table
 *
 *   GET  /studio/status    — is studio mode active? returns session info + commits
 *   GET  /studio/commits   — session commit log since fork point
 *   GET  /studio/timeline  — checkpoint timeline with timestamps
 *   POST /studio/rollback  — hard reset HEAD to a prior commit hash
 *   POST /studio/reset     — clear the in-memory session history + Claude resume id
 *   POST /studio/chat      — run the Claude agent for one turn
 *
 * ## Studio mode detection
 *
 * Studio mode is active when a `.studio` JSON file exists at REPO_ROOT.
 * This file contains the current sessionId and branch name. It is created
 * by the studio start script and deleted on teardown.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { runAgent, REPO_ROOT, resolveSuperfieldApiUrl } from "./agent";
import {
  getCurrentBranch,
  getSessionCommits,
  getTimelineCommits,
  rollbackTo,
  createCheckpointCommit,
} from "./git";
import {
  parseControlInfo,
  validateRollbackHash,
  validateControlMessage,
  type ControlMessage,
} from "./helpers";
import { getCorsHeaders, getAuthenticatedUser } from "./auth";
import { makeJson } from "../lib/response";
import { appendTraceLog } from "@superfield/core";

// In-memory session context per studio session
const sessionMessages: ControlMessage[] = [];

async function resetClaudeSessionStore(): Promise<void> {
  const res = await fetch(`${resolveSuperfieldApiUrl()}/studio/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`POST /studio/reset failed: ${res.status}`);
  }
}

/**
 * Extract a plain-language checkpoint summary from the agent's reply.
 *
 * Produces a short (under 72 chars), jargon-free summary suitable for a
 * commit message. Falls back to a trimmed version of the user's request
 * if the reply is unusable.
 */
function extractCheckpointSummary(
  agentReply: string,
  userMessage: string,
): string {
  // Use the first sentence of the agent reply as the summary.
  const firstSentence = agentReply.split(/[.\n]/)[0]?.trim();
  if (firstSentence && firstSentence.length > 5 && firstSentence.length <= 72) {
    return firstSentence;
  }
  // If the first sentence is too long, truncate it.
  if (firstSentence && firstSentence.length > 72) {
    return firstSentence.slice(0, 69) + "...";
  }
  // Fallback: use a summary of the user's request.
  const userSummary = userMessage.slice(0, 60).trim();
  return `Design change: ${userSummary}`;
}

function isControlMode(): boolean {
  return existsSync(join(REPO_ROOT, ".studio"));
}

function getControlInfo(): { sessionId: string; branch: string } | null {
  const studioFile = join(REPO_ROOT, ".studio");
  if (!existsSync(studioFile)) return null;
  return parseControlInfo(readFileSync(studioFile, "utf8"));
}

export async function handleControlRequest(
  req: Request,
  url: URL,
  logDir?: string,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/studio")) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // Authentication guard — applied at route registration level so all current
  // and future studio routes are protected without per-handler checks.
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  // GET /studio/status — is studio mode active?
  if (req.method === "GET" && url.pathname === "/studio/status") {
    const info = getControlInfo();
    if (!info) return json({ active: false });
    const branch = await getCurrentBranch();
    const commits = await getSessionCommits();
    const timeline = await getTimelineCommits();
    return json({ active: true, ...info, branch, commits, timeline });
  }

  if (req.method === "POST" && url.pathname === "/studio/debug/trace") {
    const body = (await req.json().catch(() => ({}))) as {
      kind?: "entry" | "breadcrumb";
      ts?: number;
      level?: "error" | "warn" | "info" | "debug" | "trace";
      source?: string;
      message?: string;
      stack?: string;
      context?: Record<string, unknown>;
      category?: "route" | "fetch" | "ws" | "user" | "lifecycle";
      data?: Record<string, unknown>;
      breadcrumbs?: unknown;
    };
    if (!body.message || !body.source || !body.level) {
      return json({ error: "trace payload is required" }, 400);
    }
    appendTraceLog(
      {
        ts: new Date(body.ts ?? Date.now()).toISOString(),
        origin: "browser",
        level: body.level,
        source: body.source,
        message: body.message,
        stack: body.stack,
        context: {
          kind: body.kind ?? "entry",
          category: body.category,
          data: body.data,
          ...(body.context ?? {}),
        },
      },
      logDir,
    );
    return json({ ok: true });
  }

  if (!isControlMode()) {
    return json({ error: "Studio mode is not active" }, 403);
  }

  const info = getControlInfo();
  if (!info) {
    return json({ error: "Studio mode active but control info missing" }, 500);
  }

  // GET /studio/commits — session commit log
  if (req.method === "GET" && url.pathname === "/studio/commits") {
    const commits = await getSessionCommits();
    return json({ commits });
  }

  // GET /studio/timeline — checkpoint timeline with timestamps
  if (req.method === "GET" && url.pathname === "/studio/timeline") {
    const timeline = await getTimelineCommits();
    return json({ timeline });
  }

  // POST /studio/rollback — rollback to a prior commit, discarding later commits
  if (req.method === "POST" && url.pathname === "/studio/rollback") {
    const { hash } = await req.json();
    const validatedHash = validateRollbackHash(hash);
    if (!validatedHash) return json({ error: "hash required" }, 400);
    await rollbackTo(validatedHash);
    const commits = await getSessionCommits();
    const timeline = await getTimelineCommits();
    return json({ ok: true, commits, timeline });
  }

  // POST /studio/reset — clear session context
  if (req.method === "POST" && url.pathname === "/studio/reset") {
    try {
      await resetClaudeSessionStore();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: `reset failed: ${msg}` }, 502);
    }
    sessionMessages.length = 0;
    return json({ ok: true });
  }

  // POST /studio/chat — main agent interaction
  if (req.method === "POST" && url.pathname === "/studio/chat") {
    const { message } = await req.json();
    const validatedMessage = validateControlMessage(message);
    if (!validatedMessage) return json({ error: "message required" }, 400);

    sessionMessages.push({ role: "user", content: validatedMessage });

    const reply = await runAgent(sessionMessages, info.branch);

    sessionMessages.push({ role: "assistant", content: reply });

    // After a Design mode turn, create a checkpoint commit if there are changes.
    // The agent may have already committed (per system prompt), but if not,
    // we ensure exactly one checkpoint exists for each turn that produces changes.
    await createCheckpointCommit(
      extractCheckpointSummary(reply, validatedMessage),
    );

    const timeline = await getTimelineCommits();
    const commits = await getSessionCommits();
    return json({ reply, commits, timeline });
  }

  return null;
}
