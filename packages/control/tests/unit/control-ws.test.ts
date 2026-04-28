import { describe, it, expect, vi } from "vitest";
import type { ServerWebSocket } from "bun";
import { controlWsHandler, type WsData } from "../../src/control-ws";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MockWs {
  send: (msg: string) => number;
  data: WsData;
  sent: string[];
  frames: () => Array<{ type: string; [k: string]: unknown }>;
}

/** Cast a mock ws to ServerWebSocket<WsData> for handler calls.
 *  The handler only touches `send` and `data`, so the partial mock is safe. */
function asServerWs(ws: MockWs): ServerWebSocket<WsData> {
  return ws as unknown as ServerWebSocket<WsData>;
}

function makeWs(data: Partial<WsData> = {}): MockWs {
  const sent: string[] = [];
  return {
    send: (msg: string) => sent.push(msg),
    data: {
      superfieldApiUrl: "http://127.0.0.1:7837",
      ...data,
    } as WsData,
    sent,
    frames: () => sent.map((s) => JSON.parse(s)),
  };
}

/** Build a ReadableStream that emits the given SSE text then closes. */
function makeSseStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

/** streamTurn stub that emits the given SSE text. */
function makeStreamTurn(sseText: string): WsData["_streamTurn"] {
  return () => makeSseStream(sseText);
}

// ── Invalid frames ─────────────────────────────────────────────────────────────

describe("invalid JSON", () => {
  it("sends error frame", async () => {
    const ws = makeWs();
    await controlWsHandler.message(asServerWs(ws), "not-json");
    expect(ws.frames()[0]).toEqual({
      type: "error",
      message: "Invalid JSON frame",
    });
  });
});

// ── turn frame ────────────────────────────────────────────────────────────────

describe("turn frame", () => {
  it("default mode is design (not passed in turn frame)", async () => {
    const streamTurnSpy = vi
      .fn()
      .mockReturnValue(
        makeSseStream(
          'event: session\ndata: {"sessionId":"sid1"}\n\nevent: done\ndata: {"filesChanged":[]}\n\n',
        ),
      );
    const ws = makeWs({ _streamTurn: streamTurnSpy });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "hello" }),
    );
    const [, , , mode] = streamTurnSpy.mock.calls[0] as [
      string,
      string,
      string | undefined,
      string,
    ];
    expect(mode).toBe("design");
  });

  it("mode: question is forwarded to streamTurn", async () => {
    const streamTurnSpy = vi
      .fn()
      .mockReturnValue(
        makeSseStream(
          'event: session\ndata: {"sessionId":"sid"}\n\nevent: done\ndata: {"filesChanged":[]}\n\n',
        ),
      );
    const ws = makeWs({ _streamTurn: streamTurnSpy });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "q", mode: "question" }),
    );
    const [, , , mode] = streamTurnSpy.mock.calls[0] as unknown as [
      string,
      string,
      string,
      string,
    ];
    expect(mode).toBe("question");
  });

  it("SSE data line → chunk frame", async () => {
    const ws = makeWs({
      _streamTurn: makeStreamTurn(
        'event: session\ndata: {"sessionId":"s1"}\n\ndata: hello world\n\nevent: done\ndata: {"filesChanged":[]}\n\n',
      ),
    });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "test" }),
    );
    const chunks = ws.frames().filter((f) => f.type === "chunk");
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.some((c) =>
        ((c as unknown as { text: string }).text ?? "").includes("hello world"),
      ),
    ).toBe(true);
  });

  it("event:session captures sessionId, included in final done frame", async () => {
    const ws = makeWs({
      _streamTurn: makeStreamTurn(
        'event: session\ndata: {"sessionId":"my-session-id"}\n\nevent: done\ndata: {"filesChanged":["a.ts"]}\n\n',
      ),
    });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "test" }),
    );
    const done = ws.frames().find((f) => f.type === "done") as
      | { sessionId: string; filesChanged: string[] }
      | undefined;
    expect(done?.sessionId).toBe("my-session-id");
    expect(done?.filesChanged).toEqual(["a.ts"]);
  });

  it("event:error → error frame sent, no done frame", async () => {
    const ws = makeWs({
      _streamTurn: makeStreamTurn(
        'event: session\ndata: {"sessionId":"s"}\n\nevent: error\ndata: "spawn failed"\n\n',
      ),
    });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "test" }),
    );
    const frames = ws.frames();
    expect(frames.some((f) => f.type === "error")).toBe(true);
    expect(frames.some((f) => f.type === "done")).toBe(false);
  });

  it("reader throws non-AbortError → error frame", async () => {
    const errorStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("network blew up"));
      },
    });
    const ws = makeWs({ _streamTurn: () => errorStream });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "test" }),
    );
    expect(ws.frames().some((f) => f.type === "error")).toBe(true);
  });

  it("reader throws AbortError → NO error frame", async () => {
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const abortStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(abortErr);
      },
    });
    const ws = makeWs({ _streamTurn: () => abortStream });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "test" }),
    );
    expect(ws.frames().every((f) => f.type !== "error")).toBe(true);
  });

  it("second turn frame aborts the first AbortController", async () => {
    // Capture the AbortControllers created for each turn.
    const _abortControllers: AbortController[] = [];
    const secondStream = makeSseStream(
      'event: session\ndata: {"sessionId":"s2"}\n\nevent: done\ndata: {"filesChanged":[]}\n\n',
    );
    let calls = 0;
    const ws = makeWs({
      _streamTurn: (_msg, _key, _dir, _mode, fetchFn) => {
        calls++;
        if (calls === 1) {
          // Record the AbortController by making a dummy fetch call to capture the signal.
          const neverClosing = new ReadableStream<Uint8Array>({
            start() {
              /* never resolves */
            },
          });
          // The abortableFetch wraps the signal — grab it via a spy on the ac.
          // Instead, we examine ws.data.abortController after the second turn fires.
          void fetchFn; // suppress unused warning
          return neverClosing;
        }
        return secondStream;
      },
    });

    // Fire first turn (don't await — stream never closes).
    const p1 = controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "first" }),
    );

    // Let the first turn start and get its AbortController recorded.
    await new Promise((r) => setTimeout(r, 5));
    const firstAc = ws.data.abortController;
    expect(firstAc).toBeDefined();

    // Fire second turn — this should abort the first AC and replace it.
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "turn", message: "second" }),
    );

    // The first AbortController should now be aborted.
    expect(firstAc!.signal.aborted).toBe(true);
    // The WS has a new AbortController for the second turn.
    expect(ws.data.abortController).not.toBe(firstAc);

    void Promise.resolve(p1).catch(() => {});
  });
});

// ── steer frame ───────────────────────────────────────────────────────────────

describe("steer frame", () => {
  it("successful POST → steer-ack with requestId", async () => {
    const ws = makeWs({
      _fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ requestId: "req-abc", accepted: true }),
      }),
    });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({
        type: "steer",
        context: "focus on auth",
        sessionId: "s1",
      }),
    );
    const ack = ws.frames().find((f) => f.type === "steer-ack") as
      | { requestId: string }
      | undefined;
    expect(ack?.requestId).toBe("req-abc");
  });

  it('fetch throws → error frame with "Steer failed:" prefix', async () => {
    const ws = makeWs({
      _fetch: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "steer", context: "x", sessionId: "s1" }),
    );
    const err = ws.frames().find((f) => f.type === "error") as
      | { message: string }
      | undefined;
    expect(err?.message).toMatch(/^Steer failed:/);
  });

  it("POST goes to <superfieldApiUrl>/steer/context", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ requestId: "r" }),
    });
    const ws = makeWs({
      superfieldApiUrl: "http://custom:9999",
      _fetch: fetchSpy,
    });
    await controlWsHandler.message(
      asServerWs(ws),
      JSON.stringify({ type: "steer", context: "focus", sessionId: "s1" }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://custom:9999/steer/context",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

// ── close ─────────────────────────────────────────────────────────────────────

describe("close", () => {
  it("aborts in-flight AbortController on disconnect", () => {
    const ac = new AbortController();
    const ws = makeWs({ abortController: ac });
    controlWsHandler.close!(asServerWs(ws), 1000, "");
    expect(ac.signal.aborted).toBe(true);
  });

  it("no-op when no AbortController present", () => {
    const ws = makeWs();
    expect(() =>
      controlWsHandler.close!(asServerWs(ws), 1000, ""),
    ).not.toThrow();
  });
});
