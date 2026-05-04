/**
 * Unit tests for packages/control/src/mock-routes.ts
 *
 * Covers:
 *   - GET /studio/mock-routes  — returns route list
 *   - POST /studio/mock-routes/:id/toggle — toggles enabled state
 *   - Negative paths: non-matching routes, unknown IDs
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  handleMockRoutesRequest,
  resetRegistry,
  type MockRoute,
} from "../../src/mock-routes";

function makeReq(method: string, pathname: string): Request {
  return new Request(`http://localhost${pathname}`, { method });
}
function makeUrl(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

const SEED: MockRoute[] = [
  { id: "route-a", method: "GET", path: "/api/a", enabled: true },
  { id: "route-b", method: "POST", path: "/api/b", enabled: false },
];

beforeEach(() => {
  resetRegistry(SEED);
});

// ── GET /studio/mock-routes ───────────────────────────────────────────────────

describe("GET /studio/mock-routes", () => {
  it("returns 200 with a routes array", async () => {
    const res = handleMockRoutesRequest(
      makeReq("GET", "/studio/mock-routes"),
      makeUrl("/studio/mock-routes"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { routes: MockRoute[] };
    expect(Array.isArray(body.routes)).toBe(true);
    expect(body.routes.length).toBe(2);
  });

  it("each route has id, method, path, enabled fields", async () => {
    const res = handleMockRoutesRequest(
      makeReq("GET", "/studio/mock-routes"),
      makeUrl("/studio/mock-routes"),
    );
    const { routes } = (await res!.json()) as { routes: MockRoute[] };
    for (const r of routes) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.method).toBe("string");
      expect(typeof r.path).toBe("string");
      expect(typeof r.enabled).toBe("boolean");
    }
  });

  it("returns null for non-matching path", () => {
    const res = handleMockRoutesRequest(
      makeReq("GET", "/studio/other"),
      makeUrl("/studio/other"),
    );
    expect(res).toBeNull();
  });

  it("returns null for GET on a non-/studio/mock-routes path", () => {
    const res = handleMockRoutesRequest(
      makeReq("GET", "/studio/features"),
      makeUrl("/studio/features"),
    );
    expect(res).toBeNull();
  });
});

// ── POST /studio/mock-routes/:id/toggle ───────────────────────────────────────

describe("POST /studio/mock-routes/:id/toggle", () => {
  it("toggles an enabled route to disabled", async () => {
    const res = handleMockRoutesRequest(
      makeReq("POST", "/studio/mock-routes/route-a/toggle"),
      makeUrl("/studio/mock-routes/route-a/toggle"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as MockRoute;
    expect(body.id).toBe("route-a");
    expect(body.enabled).toBe(false);
  });

  it("toggles a disabled route to enabled", async () => {
    const res = handleMockRoutesRequest(
      makeReq("POST", "/studio/mock-routes/route-b/toggle"),
      makeUrl("/studio/mock-routes/route-b/toggle"),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as MockRoute;
    expect(body.id).toBe("route-b");
    expect(body.enabled).toBe(true);
  });

  it("toggling twice returns to original state", async () => {
    const toggle = (id: string) =>
      handleMockRoutesRequest(
        makeReq("POST", `/studio/mock-routes/${id}/toggle`),
        makeUrl(`/studio/mock-routes/${id}/toggle`),
      );

    await toggle("route-a");
    const res = await toggle("route-a");
    const body = (await res!.json()) as MockRoute;
    expect(body.enabled).toBe(true); // route-a started enabled
  });

  it("persists toggle across subsequent GET", async () => {
    handleMockRoutesRequest(
      makeReq("POST", "/studio/mock-routes/route-a/toggle"),
      makeUrl("/studio/mock-routes/route-a/toggle"),
    );

    const listRes = handleMockRoutesRequest(
      makeReq("GET", "/studio/mock-routes"),
      makeUrl("/studio/mock-routes"),
    );
    const { routes } = (await listRes!.json()) as { routes: MockRoute[] };
    const a = routes.find((r) => r.id === "route-a");
    expect(a?.enabled).toBe(false);
  });

  it("returns 404 for unknown route id", async () => {
    const res = handleMockRoutesRequest(
      makeReq("POST", "/studio/mock-routes/no-such-route/toggle"),
      makeUrl("/studio/mock-routes/no-such-route/toggle"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns null for non-matching method on toggle path", () => {
    const res = handleMockRoutesRequest(
      makeReq("GET", "/studio/mock-routes/route-a/toggle"),
      makeUrl("/studio/mock-routes/route-a/toggle"),
    );
    expect(res).toBeNull();
  });

  it("returns null for DELETE on /studio/mock-routes", () => {
    const res = handleMockRoutesRequest(
      makeReq("DELETE", "/studio/mock-routes"),
      makeUrl("/studio/mock-routes"),
    );
    expect(res).toBeNull();
  });
});
