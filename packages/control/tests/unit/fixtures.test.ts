/**
 * Unit tests for packages/control/src/fixtures.ts
 *
 * Covers:
 *   - Unknown route → empty fixture list
 *   - Route with fixtures → lists them
 *   - Activate → writes active-fixtures.json
 *   - Get active → reads active-fixtures.json
 *   - Non-matching path → null
 *   - Missing route param → validation error
 *   - Active fixture reflected in list response
 */

import { describe, it, expect } from "vitest";
import { handleFixturesRequest } from "../../src/fixtures";
import fsp from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";

function makeReq(method: string, pathname: string, body?: unknown): Request {
  const url = `http://localhost${pathname}`;
  if (body !== undefined) {
    return new Request(url, {
      method,
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Request(url, { method });
}

function makeUrl(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

async function makeTmpDir(): Promise<string> {
  const dir = join(os.tmpdir(), `fixtures-test-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

// ── GET /studio/fixtures — non-matching paths ─────────────────────────────────

describe("non-matching paths", () => {
  it("returns null for GET /studio/other", async () => {
    const dir = await makeTmpDir();
    const res = await handleFixturesRequest(
      makeReq("GET", "/studio/other"),
      makeUrl("/studio/other"),
      dir,
    );
    expect(res).toBeNull();
  });

  it("returns null for DELETE /studio/fixtures", async () => {
    const dir = await makeTmpDir();
    const res = await handleFixturesRequest(
      makeReq("DELETE", "/studio/fixtures"),
      makeUrl("/studio/fixtures"),
      dir,
    );
    expect(res).toBeNull();
  });
});

// ── GET /studio/fixtures — unknown route ──────────────────────────────────────

describe("GET /studio/fixtures — unknown route", () => {
  it("returns empty fixture list when directory does not exist", async () => {
    const dir = await makeTmpDir();
    const res = await handleFixturesRequest(
      makeReq("GET", "/studio/fixtures?route=%2Fapi%2Funknown"),
      makeUrl("/studio/fixtures?route=%2Fapi%2Funknown"),
      dir,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      fixtures: string[];
      active: string | null;
    };
    expect(body.fixtures).toEqual([]);
    expect(body.active).toBeNull();
  });

  it("returns validation error when route param is missing", async () => {
    const dir = await makeTmpDir();
    const res = await handleFixturesRequest(
      makeReq("GET", "/studio/fixtures"),
      makeUrl("/studio/fixtures"),
      dir,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});

// ── GET /studio/fixtures — route with fixtures ────────────────────────────────

describe("GET /studio/fixtures — route with fixtures", () => {
  it("lists fixture files for a known route", async () => {
    const repoPath = await makeTmpDir();
    const route = "/api/users";
    // Sanitised route: api__users
    const sanitised = "api__users";
    const fixtureDir = join(repoPath, ".studio", "fixtures", sanitised);
    await fsp.mkdir(fixtureDir, { recursive: true });
    await fsp.writeFile(join(fixtureDir, "empty.json"), "[]");
    await fsp.writeFile(join(fixtureDir, "with-data.json"), "[{}]");

    const res = await handleFixturesRequest(
      makeReq("GET", `/studio/fixtures?route=${encodeURIComponent(route)}`),
      makeUrl(`/studio/fixtures?route=${encodeURIComponent(route)}`),
      repoPath,
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      fixtures: string[];
      active: string | null;
    };
    expect(body.fixtures).toContain("empty.json");
    expect(body.fixtures).toContain("with-data.json");
    expect(body.active).toBeNull();
  });
});

// ── POST /studio/fixtures/activate ───────────────────────────────────────────

describe("POST /studio/fixtures/activate", () => {
  it("writes active-fixtures.json with route and fixture", async () => {
    const repoPath = await makeTmpDir();
    const route = "/api/users";
    const fixture = "with-data.json";

    const res = await handleFixturesRequest(
      makeReq("POST", "/studio/fixtures/activate", { route, fixture }),
      makeUrl("/studio/fixtures/activate"),
      repoPath,
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const filePath = join(repoPath, ".studio", "active-fixtures.json");
    const written = JSON.parse(await fsp.readFile(filePath, "utf-8")) as Record<
      string,
      string
    >;
    expect(written[route]).toBe(fixture);
  });

  it("updates existing active-fixtures.json without overwriting other routes", async () => {
    const repoPath = await makeTmpDir();
    const studioDir = join(repoPath, ".studio");
    await fsp.mkdir(studioDir, { recursive: true });
    await fsp.writeFile(
      join(studioDir, "active-fixtures.json"),
      JSON.stringify({ "/api/other": "other.json" }),
    );

    await handleFixturesRequest(
      makeReq("POST", "/studio/fixtures/activate", {
        route: "/api/users",
        fixture: "empty.json",
      }),
      makeUrl("/studio/fixtures/activate"),
      repoPath,
    );

    const written = JSON.parse(
      await fsp.readFile(join(studioDir, "active-fixtures.json"), "utf-8"),
    ) as Record<string, string>;
    expect(written["/api/other"]).toBe("other.json");
    expect(written["/api/users"]).toBe("empty.json");
  });

  it("returns validation error when route is missing", async () => {
    const dir = await makeTmpDir();
    const res = await handleFixturesRequest(
      makeReq("POST", "/studio/fixtures/activate", { fixture: "foo.json" }),
      makeUrl("/studio/fixtures/activate"),
      dir,
    );
    expect(res!.status).toBe(400);
  });

  it("returns validation error when fixture is missing", async () => {
    const dir = await makeTmpDir();
    const res = await handleFixturesRequest(
      makeReq("POST", "/studio/fixtures/activate", { route: "/api/users" }),
      makeUrl("/studio/fixtures/activate"),
      dir,
    );
    expect(res!.status).toBe(400);
  });
});

// ── GET /studio/fixtures/active ───────────────────────────────────────────────

describe("GET /studio/fixtures/active", () => {
  it("returns empty activeFixtures when file does not exist", async () => {
    const dir = await makeTmpDir();
    const res = await handleFixturesRequest(
      makeReq("GET", "/studio/fixtures/active"),
      makeUrl("/studio/fixtures/active"),
      dir,
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      activeFixtures: Record<string, string>;
    };
    expect(body.activeFixtures).toEqual({});
  });

  it("reads active-fixtures.json and returns its contents", async () => {
    const repoPath = await makeTmpDir();
    const studioDir = join(repoPath, ".studio");
    await fsp.mkdir(studioDir, { recursive: true });
    const data = { "/api/users": "empty.json", "/api/posts": "many.json" };
    await fsp.writeFile(
      join(studioDir, "active-fixtures.json"),
      JSON.stringify(data),
    );

    const res = await handleFixturesRequest(
      makeReq("GET", "/studio/fixtures/active"),
      makeUrl("/studio/fixtures/active"),
      repoPath,
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      activeFixtures: Record<string, string>;
    };
    expect(body.activeFixtures["/api/users"]).toBe("empty.json");
    expect(body.activeFixtures["/api/posts"]).toBe("many.json");
  });

  it("reflects activated fixture in subsequent GET /studio/fixtures list", async () => {
    const repoPath = await makeTmpDir();
    const route = "/api/users";
    const sanitised = "api__users";
    const fixtureDir = join(repoPath, ".studio", "fixtures", sanitised);
    await fsp.mkdir(fixtureDir, { recursive: true });
    await fsp.writeFile(join(fixtureDir, "empty.json"), "[]");

    // Activate
    await handleFixturesRequest(
      makeReq("POST", "/studio/fixtures/activate", {
        route,
        fixture: "empty.json",
      }),
      makeUrl("/studio/fixtures/activate"),
      repoPath,
    );

    // List
    const listRes = await handleFixturesRequest(
      makeReq("GET", `/studio/fixtures?route=${encodeURIComponent(route)}`),
      makeUrl(`/studio/fixtures?route=${encodeURIComponent(route)}`),
      repoPath,
    );
    const body = (await listRes!.json()) as {
      fixtures: string[];
      active: string | null;
    };
    expect(body.active).toBe("empty.json");
  });
});
