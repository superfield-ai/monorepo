import { describe, it, expect, vi } from "vitest";
import { pollOperation } from "../../gcp/operations.ts";
import type { HttpDeps } from "../../gcp/http.ts";

function makeDeps(fetchFn: (url: string) => Promise<Response>): HttpDeps {
  return {
    fetch: async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return fetchFn(url);
    },
    getAccessToken: async () => "test-token",
  };
}

describe("pollOperation", () => {
  it("resolves when operation status is DONE", async () => {
    const deps = makeDeps(async () =>
      new Response(JSON.stringify({ status: "DONE" }), { status: 200 }),
    );

    await expect(
      pollOperation("https://example.com/operations/op-123", deps, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when status is DONE with error field", async () => {
    const deps = makeDeps(async () =>
      new Response(
        JSON.stringify({
          status: "DONE",
          error: { message: "something went wrong" },
        }),
        { status: 200 },
      ),
    );

    await expect(
      pollOperation("https://example.com/operations/op-err", deps, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("something went wrong");
  });

  it("throws with JSON-stringified error when error has no message field", async () => {
    const deps = makeDeps(async () =>
      new Response(
        JSON.stringify({
          status: "DONE",
          error: { code: 500, status: "INTERNAL" },
        }),
        { status: 200 },
      ),
    );

    await expect(
      pollOperation("https://example.com/operations/op-err2", deps, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/INTERNAL/);
  });

  it("throws on timeout when operation never completes", async () => {
    const deps = makeDeps(async () =>
      new Response(JSON.stringify({ status: "RUNNING" }), { status: 200 }),
    );

    await expect(
      pollOperation("https://example.com/operations/op-slow", deps, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Operation timed out: https://example.com/operations/op-slow");
  });

  it("polls multiple times before DONE", async () => {
    let callCount = 0;
    const deps = makeDeps(async () => {
      callCount++;
      const status = callCount >= 3 ? "DONE" : "RUNNING";
      return new Response(JSON.stringify({ status }), { status: 200 });
    });

    await pollOperation("https://example.com/operations/op-multi", deps, {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});
