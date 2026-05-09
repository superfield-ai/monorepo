/**
 * @file fixtures.ts
 *
 * Fixture switcher endpoints for Studio (C-9 fixture management).
 *
 * Routes:
 *   GET  /studio/fixtures?route=<route>  — list fixtures for a route
 *   POST /studio/fixtures/activate       — activate a fixture for a route
 *   GET  /studio/fixtures/active         — get all active fixtures
 *
 * Fixtures are stored in `<repoPath>/.studio/fixtures/<route>/`.
 * Active selections are persisted to `<repoPath>/.studio/active-fixtures.json`.
 */

import fsp from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorResponse } from "../lib/error-envelope";

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function studioDir(repoPath: string): string {
  return resolve(repoPath, ".studio");
}

function fixturesDir(repoPath: string, route: string): string {
  // Sanitise route: strip leading slash, replace internal slashes with __
  const sanitised = route.replace(/^\//, "").replace(/\//g, "__");
  return join(studioDir(repoPath), "fixtures", sanitised);
}

function activeFixturesPath(repoPath: string): string {
  return join(studioDir(repoPath), "active-fixtures.json");
}

// ── Handler implementations ───────────────────────────────────────────────────

/**
 * GET /studio/fixtures?route=<route>
 * Returns { fixtures: string[], active: string | null }
 */
async function listFixtures(url: URL, repoPath: string): Promise<Response> {
  const route = url.searchParams.get("route");
  if (!route) {
    return errorResponse({
      code: "validation",
      message: "route query parameter is required",
      hint: "Pass ?route=<route> to GET /studio/fixtures.",
    });
  }

  const dir = fixturesDir(repoPath, route);
  let fixtures: string[] = [];

  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    fixtures = entries
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // Directory doesn't exist — return empty list
    return jsonOk({ fixtures: [], active: null });
  }

  // Read active fixture for this route
  let active: string | null = null;
  try {
    const raw = await fsp.readFile(activeFixturesPath(repoPath), "utf-8");
    const activeFixtures = JSON.parse(raw) as Record<string, string>;
    active = activeFixtures[route] ?? null;
  } catch {
    // File doesn't exist yet
  }

  return jsonOk({ fixtures, active });
}

/**
 * POST /studio/fixtures/activate
 * Body: { route: string, fixture: string }
 * Returns { ok: true }
 */
async function activateFixture(
  req: Request,
  repoPath: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse({
      code: "validation",
      message: "Request body must be valid JSON",
      hint: "POST { route: string, fixture: string } to /studio/fixtures/activate.",
    });
  }

  const { route, fixture } = body as Record<string, unknown>;

  if (typeof route !== "string" || !route) {
    return errorResponse({
      code: "validation",
      message: "route is required",
      hint: "POST { route: string, fixture: string } to /studio/fixtures/activate.",
    });
  }
  if (typeof fixture !== "string" || !fixture) {
    return errorResponse({
      code: "validation",
      message: "fixture is required",
      hint: "POST { route: string, fixture: string } to /studio/fixtures/activate.",
    });
  }

  const dir = studioDir(repoPath);
  await fsp.mkdir(dir, { recursive: true });

  const filePath = activeFixturesPath(repoPath);

  // Read existing active fixtures
  let activeFixtures: Record<string, string> = {};
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    activeFixtures = JSON.parse(raw) as Record<string, string>;
  } catch {
    // File doesn't exist yet; start fresh
  }

  activeFixtures[route] = fixture;
  await fsp.writeFile(
    filePath,
    JSON.stringify(activeFixtures, null, 2),
    "utf-8",
  );

  return jsonOk({ ok: true });
}

/**
 * GET /studio/fixtures/active
 * Returns { activeFixtures: Record<string, string> }
 */
async function getActiveFixtures(repoPath: string): Promise<Response> {
  try {
    const raw = await fsp.readFile(activeFixturesPath(repoPath), "utf-8");
    const activeFixtures = JSON.parse(raw) as Record<string, string>;
    return jsonOk({ activeFixtures });
  } catch {
    return jsonOk({ activeFixtures: {} });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Top-level fixture handler. Returns null for non-matching paths so the
 * router can fall through to other handlers.
 */
export async function handleFixturesRequest(
  req: Request,
  url: URL,
  repoPath: string,
): Promise<Response | null> {
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/studio/fixtures/active") {
    return getActiveFixtures(repoPath);
  }

  if (req.method === "POST" && pathname === "/studio/fixtures/activate") {
    return activateFixture(req, repoPath);
  }

  if (req.method === "GET" && pathname === "/studio/fixtures") {
    return listFixtures(url, repoPath);
  }

  return null;
}
