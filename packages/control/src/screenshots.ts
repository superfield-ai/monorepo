/**
 * @file screenshots.ts
 *
 * Screenshot listing and diff endpoints (issues #249, #250).
 *
 *   GET /studio/screenshots/:sessionId
 *   GET /studio/screenshots/:sessionId/:filename
 *   GET /studio/screenshots/diff/:sessionId/:beforeTurn/:afterTurn
 *
 * Reads the `docs/studio-sessions/<sessionId>/` directory and returns a
 * sorted list of `{ filename, path, url }` objects for each `turn-N.png`
 * file found there.
 *
 * List response shape:
 * ```json
 * {
 *   "sessionId": "<session-id>",
 *   "screenshots": [
 *     { "filename": "turn-1.png", "turnIndex": 1, "url": "/studio/screenshots/<sessionId>/turn-1.png" }
 *   ]
 * }
 * ```
 *
 * Diff response shape (GET /studio/screenshots/diff/:sessionId/:beforeTurn/:afterTurn):
 * ```json
 * {
 *   "sessionId": "<session-id>",
 *   "beforeTurn": 1,
 *   "afterTurn": 2,
 *   "beforeUrl": "/studio/screenshots/<sessionId>/turn-1.png",
 *   "afterUrl": "/studio/screenshots/<sessionId>/turn-2.png",
 *   "beforeExists": true,
 *   "afterExists": true
 * }
 * ```
 *
 * Individual PNG files are served via:
 *   GET /studio/screenshots/:sessionId/:filename
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorResponse } from "../lib/error-envelope";
import { logBackendError } from "./debug-events";

export interface ScreenshotEntry {
  readonly filename: string;
  readonly turnIndex: number;
  readonly url: string;
}

function repoRoot(): string {
  return process.env.SUPERFIELD_REPO_ROOT ?? process.cwd();
}

function sessionDir(sessionId: string): string {
  return resolve(repoRoot(), "docs", "studio-sessions", sessionId);
}

/** GET /studio/screenshots/:sessionId */
function handleListScreenshots(sessionId: string): Response {
  const dir = sessionDir(sessionId);
  const screenshots: ScreenshotEntry[] = [];

  if (existsSync(dir)) {
    try {
      const files = readdirSync(dir).filter((f) => /^turn-\d+\.png$/.test(f));
      for (const filename of files) {
        const m = filename.match(/^turn-(\d+)\.png$/);
        const turnIndex = m?.[1] !== undefined ? parseInt(m[1], 10) : 0;
        screenshots.push({
          filename,
          turnIndex,
          url: `/studio/screenshots/${encodeURIComponent(sessionId)}/${filename}`,
        });
      }
      screenshots.sort((a, b) => a.turnIndex - b.turnIndex);
    } catch (err) {
      logBackendError(err, `GET /studio/screenshots/${sessionId}`);
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse({
        code: "server",
        message: `Failed to read screenshots for session ${sessionId}: ${message}`,
        hint: "Verify docs/studio-sessions/ is readable.",
      });
    }
  }

  return new Response(JSON.stringify({ sessionId, screenshots }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** GET /studio/screenshots/:sessionId/:filename — serve raw PNG */
function handleServePng(sessionId: string, filename: string): Response {
  if (!/^turn-\d+\.png$/.test(filename)) {
    return errorResponse({
      code: "not_found",
      message: "Screenshot not found",
      hint: "Filename must match turn-<N>.png",
    });
  }
  const filePath = join(sessionDir(sessionId), filename);
  if (!existsSync(filePath)) {
    return errorResponse({
      code: "not_found",
      message: `Screenshot ${filename} not found for session ${sessionId}`,
      hint: "The turn may not have been captured yet.",
    });
  }
  return new Response(Bun.file(filePath), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

export interface ScreenshotDiff {
  readonly sessionId: string;
  readonly beforeTurn: number;
  readonly afterTurn: number;
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly beforeExists: boolean;
  readonly afterExists: boolean;
}

/** GET /studio/screenshots/diff/:sessionId/:beforeTurn/:afterTurn */
function handleScreenshotDiff(
  sessionId: string,
  beforeTurn: number,
  afterTurn: number,
): Response {
  const dir = sessionDir(sessionId);
  const beforeFilename = `turn-${beforeTurn}.png`;
  const afterFilename = `turn-${afterTurn}.png`;
  const beforeExists = existsSync(join(dir, beforeFilename));
  const afterExists = existsSync(join(dir, afterFilename));
  const base = `/studio/screenshots/${encodeURIComponent(sessionId)}`;
  const diff: ScreenshotDiff = {
    sessionId,
    beforeTurn,
    afterTurn,
    beforeUrl: `${base}/${beforeFilename}`,
    afterUrl: `${base}/${afterFilename}`,
    beforeExists,
    afterExists,
  };
  return new Response(JSON.stringify(diff), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Top-level screenshots route handler.
 * Returns null when the request does not match /studio/screenshots/* so the
 * router can fall through.
 */
export function handleScreenshotsRequest(
  req: Request,
  url: URL,
): Response | null {
  const { pathname } = url;
  if (req.method !== "GET") return null;

  // /studio/screenshots/diff/:sessionId/:beforeTurn/:afterTurn — visual diff metadata
  const diffMatch = pathname.match(
    /^\/studio\/screenshots\/diff\/([^/]+)\/(\d+)\/(\d+)$/,
  );
  if (diffMatch?.[1] && diffMatch?.[2] && diffMatch?.[3]) {
    return handleScreenshotDiff(
      decodeURIComponent(diffMatch[1]),
      parseInt(diffMatch[2], 10),
      parseInt(diffMatch[3], 10),
    );
  }

  // /studio/screenshots/:sessionId/:filename — serve a single PNG
  const fileMatch = pathname.match(/^\/studio\/screenshots\/([^/]+)\/([^/]+)$/);
  if (fileMatch?.[1] && fileMatch?.[2]) {
    return handleServePng(
      decodeURIComponent(fileMatch[1]),
      decodeURIComponent(fileMatch[2]),
    );
  }

  // /studio/screenshots/:sessionId — list screenshots for a session
  const listMatch = pathname.match(/^\/studio\/screenshots\/([^/]+)$/);
  if (listMatch?.[1]) {
    return handleListScreenshots(decodeURIComponent(listMatch[1]));
  }

  return null;
}
