/**
 * Unit tests for the typed error envelope (E6).
 */

import { describe, expect, it, vi } from "vitest";
import {
  errorEnvelope,
  errorResponse,
  statusForCode,
  wrapHandler,
} from "../../lib/error-envelope";

describe("errorEnvelope", () => {
  it("wraps a payload with ok: false", () => {
    const env = errorEnvelope({ code: "validation", message: "bad" });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("validation");
    expect(env.error.message).toBe("bad");
  });
});

describe("statusForCode", () => {
  it.each([
    ["validation", 400],
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["not_found", 404],
    ["conflict", 409],
    ["upstream", 502],
    ["unsupported", 501],
    ["server", 500],
  ] as const)("%s → %d", (code, status) => {
    expect(statusForCode(code)).toBe(status);
  });
});

describe("errorResponse", () => {
  it("returns a JSON Response with the right status and Content-Type", async () => {
    const res = errorResponse({
      code: "not_found",
      message: "missing",
      hint: "create it",
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as {
      ok: false;
      error: { code: string; message: string; hint?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_found");
    expect(body.error.hint).toBe("create it");
  });

  it("honours an explicit status override", () => {
    const res = errorResponse(
      { code: "server", message: "x" },
      { status: 503 },
    );
    expect(res.status).toBe(503);
  });
});

describe("wrapHandler", () => {
  it("returns the handler's response on success", async () => {
    const onErr = vi.fn();
    const wrapped = wrapHandler(
      "ok",
      async () => new Response("ok", { status: 200 }),
      onErr,
    );
    const res = await wrapped();
    expect(res.status).toBe(200);
    expect(onErr).not.toHaveBeenCalled();
  });

  it("converts a thrown exception to a 500 errorEnvelope", async () => {
    const onErr = vi.fn();
    const wrapped = wrapHandler(
      "boom",
      async () => {
        throw new Error("explode");
      },
      onErr,
    );
    const res = await wrapped();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("server");
    expect(body.error.message).toContain("boom");
    expect(body.error.message).toContain("explode");
    expect(onErr).toHaveBeenCalledOnce();
  });
});
