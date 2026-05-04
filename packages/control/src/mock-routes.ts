/**
 * @file mock-routes.ts
 *
 * Mock-route registry endpoints (C-9.3).
 *
 * Routes:
 *   GET  /studio/mock-routes          — { routes: MockRoute[] }
 *   POST /studio/mock-routes/:id/toggle — toggle enabled state, returns updated MockRoute
 *
 * The registry starts with a set of representative sample routes. The real
 * MSW integration (reading handlers from the running app) is deferred to a
 * future iteration; for now the in-memory map provides the full CRUD surface
 * so the UI and toggle mechanics are fully exercisable.
 */

import { errorResponse } from "../lib/error-envelope";

export interface MockRoute {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  enabled: boolean;
}

// ── In-memory registry ────────────────────────────────────────────────────────

const SEED_ROUTES: MockRoute[] = [
  { id: "auth-login", method: "POST", path: "/api/auth/login", enabled: true },
  {
    id: "auth-register",
    method: "POST",
    path: "/api/auth/register",
    enabled: true,
  },
  { id: "users-list", method: "GET", path: "/api/users", enabled: true },
  {
    id: "users-detail",
    method: "GET",
    path: "/api/users/:id",
    enabled: false,
  },
  {
    id: "feature-flags",
    method: "GET",
    path: "/api/feature-flags",
    enabled: true,
  },
  {
    id: "products-list",
    method: "GET",
    path: "/api/products",
    enabled: false,
  },
];

// Mutable in-memory registry (process-scoped singleton).
const registry = new Map<string, MockRoute>(
  SEED_ROUTES.map((r) => [r.id, { ...r }]),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function listRoutes(): Response {
  return jsonOk({ routes: [...registry.values()] });
}

function toggleRoute(id: string): Response {
  const route = registry.get(id);
  if (!route) {
    return errorResponse({
      code: "not_found",
      message: `Mock route not found: ${id}`,
      hint: `Call GET /studio/mock-routes to list available route IDs.`,
    });
  }
  route.enabled = !route.enabled;
  return jsonOk(route);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Exported for tests: lets a test seed specific routes without relying on the
 * process-level singleton.
 */
export function resetRegistry(routes: MockRoute[] = SEED_ROUTES): void {
  registry.clear();
  for (const r of routes) {
    registry.set(r.id, { ...r });
  }
}

/**
 * Top-level mock-route handler. Returns null for non-matching paths so the
 * router can fall through to other handlers.
 */
export function handleMockRoutesRequest(
  req: Request,
  url: URL,
): Response | null {
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/studio/mock-routes") {
    return listRoutes();
  }

  // POST /studio/mock-routes/:id/toggle
  const toggleMatch = pathname.match(
    /^\/studio\/mock-routes\/([^/]+)\/toggle$/,
  );
  if (req.method === "POST" && toggleMatch) {
    const id = decodeURIComponent(toggleMatch[1] ?? "");
    return toggleRoute(id);
  }

  return null;
}
