/**
 * Unit tests for the typed network wrappers (E4).
 *
 * These run in a real browser context (vitest browser provider) so `fetch`,
 * `EventSource`, and `WebSocket` are genuine browser globals. We stub `fetch`
 * for HTTP tests; SSE/WS tests use the real APIs against a fake URL and only
 * verify the wrapper's shape, not transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../../src/lib/net";
import { debugStore } from "../../src/lib/debug-store";

describe("fetchJson", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    debugStore.__resetForTest();
    originalFetch = window.fetch;
  });
  afterEach(() => {
    window.fetch = originalFetch;
  });

  it("returns ok with parsed JSON on 200", async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchJson<{ hello: string }>("/api/test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hello).toBe("world");
  });

  it("returns AppError with status on 500", async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: "server", message: "boom", hint: "retry" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchJson("/api/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("server");
      expect(result.error.message).toBe("boom");
      expect(result.error.hint).toBe("retry");
      expect(result.error.status).toBe(500);
    }
  });

  it("returns AppError code='network' on transport failure", async () => {
    window.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await fetchJson("/api/test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("network");
  });

  it("records a debug entry on failure", async () => {
    window.fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
    await fetchJson("/api/test");
    const { entries } = debugStore.getState();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("fetch");
    expect(entries[0].level).toBe("error");
  });

  it("emits a breadcrumb on success", async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await fetchJson("/api/test");
    const crumbs = debugStore.getBreadcrumbs();
    expect(crumbs.some((c) => c.category === "fetch")).toBe(true);
  });

  it("returns AppError code='parse' on non-JSON 200", async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response("not json", { status: 200 }),
    );
    const result = await fetchJson("/api/test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("parse");
  });

  it("serialises object body to JSON and sets Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    window.fetch = fetchMock;
    await fetchJson("/api/test", { method: "POST", body: { a: 1 } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
  });
});
