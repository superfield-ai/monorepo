import { describe, it, expect, vi } from "vitest";
import { googleJsonRequest } from "../../gcp/http.ts";
import type { HttpDeps } from "../../gcp/http.ts";

function makeDeps(overrides: Partial<HttpDeps> = {}): HttpDeps {
  return {
    fetch: async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    getAccessToken: async () => "test-token",
    ...overrides,
  };
}

describe("googleJsonRequest", () => {
  it("happy path returns parsed JSON", async () => {
    const deps = makeDeps({
      fetch: async () =>
        new Response(JSON.stringify({ value: 42 }), { status: 200 }),
    });
    const result = await googleJsonRequest<{ value: number }>(
      "https://example.com/api",
      {},
      deps,
    );
    expect(result).toEqual({ value: 42 });
  });

  it("sets Authorization Bearer header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const deps = makeDeps({
      getAccessToken: async () => "my-token",
      fetch: async (_url, init) => {
        const headers = init?.headers as Headers;
        capturedHeaders = Object.fromEntries(headers?.entries?.() ?? []);
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    await googleJsonRequest("https://example.com/api", {}, deps);
    expect(capturedHeaders["authorization"]).toBe("Bearer my-token");
  });

  it("throws on non-2xx response", async () => {
    const deps = makeDeps({
      fetch: async () =>
        new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    });
    await expect(
      googleJsonRequest("https://example.com/api", {}, deps),
    ).rejects.toThrow("403");
  });

  it("returns null for empty body", async () => {
    const deps = makeDeps({
      fetch: async () => new Response("", { status: 200 }),
    });
    const result = await googleJsonRequest("https://example.com/api", {}, deps);
    expect(result).toBeNull();
  });

  describe("record/replay", () => {
    it("records on first call and replays on second (no real fetch on replay)", async () => {
      const store: Record<string, string> = {};
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ recorded: true }), { status: 200 }),
      );

      const deps: HttpDeps = {
        fetch: fetchMock,
        getAccessToken: async () => "token",
        fixtureDir: "/fixtures",
        readFile: (path) => {
          if (store[path]) return store[path];
          throw new Error("ENOENT");
        },
        writeFile: (path, content) => {
          store[path] = content;
        },
      };

      // First call — live, should record
      const first = await googleJsonRequest<{ recorded: boolean }>(
        "https://example.com/resource",
        {},
        deps,
      );
      expect(first).toEqual({ recorded: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call — should replay from store, no additional fetch
      const second = await googleJsonRequest<{ recorded: boolean }>(
        "https://example.com/resource",
        {},
        deps,
      );
      expect(second).toEqual({ recorded: true });
      expect(fetchMock).toHaveBeenCalledTimes(1); // still 1
    });
  });
});
