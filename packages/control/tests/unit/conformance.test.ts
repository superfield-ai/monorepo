/**
 * Unit tests for packages/control/src/conformance.ts
 *
 * Covers:
 *   - GET /studio/conformance  — returns empty list initially
 *   - POST /studio/conformance — updates the in-memory store
 *   - GET after POST           — reflects the update
 *   - POST replaces (not appends) existing results
 *   - Non-matching paths return null
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  handleConformanceRequest,
  resetConformance,
  type ConformanceRule,
} from "../../src/conformance";

function makeReq(method: string, pathname: string, body?: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeUrl(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

const RULE_A: ConformanceRule = {
  id: "rule-1",
  name: "No direct DB access",
  status: "pass",
};

const RULE_B: ConformanceRule = {
  id: "rule-2",
  name: "Logging standard",
  status: "fail",
  detail: "Missing structured logger in 3 modules",
};

const RULE_C: ConformanceRule = {
  id: "rule-3",
  name: "Advisory: test coverage",
  status: "advisory",
  detail: "Coverage below 80%",
};

beforeEach(() => {
  resetConformance();
});

// ── GET /studio/conformance — empty state ─────────────────────────────────────

describe("GET /studio/conformance — empty state", () => {
  it("returns 200 with an empty rules array when nothing has been posted", async () => {
    const res = await handleConformanceRequest(
      makeReq("GET", "/studio/conformance"),
      makeUrl("/studio/conformance"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      rules: ConformanceRule[];
      updatedAt: string | null;
    };
    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.rules.length).toBe(0);
    expect(body.updatedAt).toBeNull();
  });
});

// ── POST /studio/conformance ──────────────────────────────────────────────────

describe("POST /studio/conformance", () => {
  it("accepts a valid rules array and returns 200 with updatedAt set", async () => {
    const res = await handleConformanceRequest(
      makeReq("POST", "/studio/conformance", { rules: [RULE_A, RULE_B] }),
      makeUrl("/studio/conformance"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      rules: ConformanceRule[];
      updatedAt: string;
    };
    expect(body.rules.length).toBe(2);
    expect(typeof body.updatedAt).toBe("string");
  });

  it("rejects a body without a rules array", async () => {
    const res = await handleConformanceRequest(
      makeReq("POST", "/studio/conformance", { something: "else" }),
      makeUrl("/studio/conformance"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it("rejects invalid status value", async () => {
    const res = await handleConformanceRequest(
      makeReq("POST", "/studio/conformance", {
        rules: [{ id: "x", name: "X rule", status: "unknown-status" }],
      }),
      makeUrl("/studio/conformance"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});

// ── GET after POST reflects update ────────────────────────────────────────────

describe("GET after POST reflects update", () => {
  it("GET returns rules that were POSTed", async () => {
    await handleConformanceRequest(
      makeReq("POST", "/studio/conformance", { rules: [RULE_A, RULE_C] }),
      makeUrl("/studio/conformance"),
    );

    const res = await handleConformanceRequest(
      makeReq("GET", "/studio/conformance"),
      makeUrl("/studio/conformance"),
    );
    const body = (await res!.json()) as {
      rules: ConformanceRule[];
      updatedAt: string;
    };
    expect(body.rules.length).toBe(2);
    expect(body.rules[0]?.id).toBe("rule-1");
    expect(body.rules[1]?.id).toBe("rule-3");
    expect(body.updatedAt).not.toBeNull();
  });
});

// ── POST replaces (not appends) ───────────────────────────────────────────────

describe("POST replaces existing results", () => {
  it("a second POST replaces, not appends, the rules", async () => {
    await handleConformanceRequest(
      makeReq("POST", "/studio/conformance", { rules: [RULE_A, RULE_B] }),
      makeUrl("/studio/conformance"),
    );

    await handleConformanceRequest(
      makeReq("POST", "/studio/conformance", { rules: [RULE_C] }),
      makeUrl("/studio/conformance"),
    );

    const res = await handleConformanceRequest(
      makeReq("GET", "/studio/conformance"),
      makeUrl("/studio/conformance"),
    );
    const body = (await res!.json()) as { rules: ConformanceRule[] };
    // Only RULE_C should remain — not all three.
    expect(body.rules.length).toBe(1);
    expect(body.rules[0]?.id).toBe("rule-3");
  });
});

// ── Non-matching paths return null ────────────────────────────────────────────

describe("non-matching paths", () => {
  it("returns null for an unrelated path", async () => {
    const result = await handleConformanceRequest(
      makeReq("GET", "/studio/other"),
      makeUrl("/studio/other"),
    );
    expect(result).toBeNull();
  });

  it("returns null for a POST to a different studio path", async () => {
    const result = await handleConformanceRequest(
      makeReq("POST", "/studio/mock-routes"),
      makeUrl("/studio/mock-routes"),
    );
    expect(result).toBeNull();
  });
});
