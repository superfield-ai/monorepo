/**
 * @file docs.ts
 *
 * Handlers for the /studio/docs endpoints.
 *
 *   GET  /studio/docs          → { files: string[] }
 *     Lists .md files from ./docs/ relative to process.cwd().
 *
 *   GET  /studio/docs/:filename → raw markdown text
 *     Reads the file and returns text/markdown.
 *     Returns 404 if file not found.
 *     Guards against path traversal: resolved path must start with docsDir.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { errorResponse } from "../lib/error-envelope";

function getDocsDir(): string {
  return resolve(process.cwd(), "docs");
}

/**
 * Handle GET /studio/docs — returns list of .md filenames.
 */
export function handleDocsListRequest(): Response {
  const docsDir = getDocsDir();

  if (!existsSync(docsDir)) {
    return new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const entries = readdirSync(docsDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();

    return new Response(JSON.stringify({ files }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse({
      code: "server",
      message: `Failed to list docs: ${message}`,
      hint: "Ensure the docs/ directory is readable.",
    });
  }
}

/**
 * Handle GET /studio/docs/:filename — returns raw markdown content.
 */
export function handleDocsFileRequest(filename: string): Response {
  const docsDir = getDocsDir();

  // Path traversal guard: only allow simple filenames with no directory separators.
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return errorResponse({
      code: "validation",
      message: "Invalid filename",
      hint: "Filename must be a plain .md file name with no path components.",
    });
  }

  const filePath = join(docsDir, filename);
  const resolvedPath = resolve(filePath);
  const resolvedDocsDir = resolve(docsDir);

  // Ensure the resolved path is within the docs directory.
  if (!resolvedPath.startsWith(resolvedDocsDir + "/") && resolvedPath !== resolvedDocsDir) {
    return errorResponse({
      code: "validation",
      message: "Path traversal denied",
      hint: "The requested file is outside the docs directory.",
    });
  }

  if (!existsSync(resolvedPath)) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const content = readFileSync(resolvedPath, "utf-8");
    return new Response(content, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse({
      code: "server",
      message: `Failed to read doc: ${message}`,
      hint: "The file may not be readable.",
    });
  }
}

/**
 * Route handler — returns a Response if the request matches a docs endpoint,
 * otherwise returns null.
 */
export function handleDocsRequest(req: Request, url: URL): Response | null {
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/studio/docs") {
    return handleDocsListRequest();
  }

  if (req.method === "GET" && pathname.startsWith("/studio/docs/")) {
    const filename = decodeURIComponent(pathname.slice("/studio/docs/".length));
    return handleDocsFileRequest(filename);
  }

  return null;
}
