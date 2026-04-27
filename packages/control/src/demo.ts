/**
 * @file demo.ts
 *
 * Demo-content endpoints (D2 / D3 / D6).
 *
 * Routes:
 *   GET /studio/demo/routes  — { routes: DemoRoute[] }
 *   GET /studio/demo/mocks   — { mocks: DemoMock[] }
 *   GET /studio/demo/issues  — { issues: DemoIssue[] }
 *
 * The seed script (scripts/seed-demo.ts, D5) writes the underlying JSON
 * fixtures to <repo>/.studio/demo/{routes,mocks,issues}.json. When a fixture
 * is absent the handler returns an empty array so the UI can render its
 * EmptyState rather than a 500.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { errorResponse } from "../lib/error-envelope";
import { logBackendError } from "./debug-events";
import { REPO_ROOT } from "./agent";

const DEMO_DIR = join(REPO_ROOT, ".studio", "demo");

function readJson(name: string): unknown {
  const path = join(DEMO_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as unknown;
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function handleResource(
  name: "routes" | "mocks" | "issues",
  emptyKey: string,
): Response {
  try {
    const data = readJson(name);
    if (data === null) {
      return jsonOk({ [emptyKey]: [] });
    }
    return jsonOk(data);
  } catch (err) {
    logBackendError(err, `GET /studio/demo/${name}`);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse({
      code: "server",
      message: `Failed to read demo ${name}: ${message}`,
      hint: `Run \`bun run scripts/seed-demo.ts\` to regenerate ${name}.json.`,
    });
  }
}

/**
 * Top-level demo route handler. Returns null for non-matching paths so the
 * router can fall through to other handlers.
 */
export function handleDemoRequest(req: Request, url: URL): Response | null {
  const { pathname } = url;
  if (req.method !== "GET") return null;

  if (pathname === "/studio/demo/routes") {
    return handleResource("routes", "routes");
  }
  if (pathname === "/studio/demo/mocks") {
    return handleResource("mocks", "mocks");
  }
  if (pathname === "/studio/demo/issues") {
    return handleResource("issues", "issues");
  }
  return null;
}
