/**
 * Unit tests for WsChatController (browser environment — real Chromium globals).
 *
 * WebSocket is stubbed with a controllable fake so no real network connection
 * is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsChatController } from "../../src/controllers/ChatController";

// ── Fake WebSocket ────────────────────────────────────────────────────────────

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  static last: FakeWebSocket | null = null;

  constructor(_url: string) {
    FakeWebSocket.last = this;
  }

  send(msg: string) {
    this.sent.push(msg);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper — simulate server open. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper — simulate server message. */
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Test helper — simulate socket error. */
  error() {
    this.onerror?.();
  }
}

beforeEach(() => {
  FakeWebSocket.last = null;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:7000" });
  vi.stubGlobal("crypto", {
    randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}`,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Initial state ─────────────────────────────────────────────────────────────

describe("initial state", () => {
  it("turnState is idle, messages is empty", () => {
    const ctrl = new WsChatController();
    expect(ctrl.getState()).toEqual({ turnState: "idle", messages: [] });
  });
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe("subscribe", () => {
  it("listener called immediately with current state", () => {
    const ctrl = new WsChatController();
    const calls: unknown[] = [];
    ctrl.subscribe((s) => calls.push(s));
    expect(calls).toHaveLength(1);
    expect((calls[0] as { turnState: string }).turnState).toBe("idle");
  });

  it("returns unsubscribe function that stops future notifications", () => {
    const ctrl = new WsChatController();
    let count = 0;
    const unsub = ctrl.subscribe(() => count++);
    unsub();
    // Subsequent state changes should NOT call the listener.
    ctrl.connect();
    FakeWebSocket.last?.error();
    expect(count).toBe(1); // only the initial call
  });
});

// ── sendMessage guards ────────────────────────────────────────────────────────

describe("sendMessage guards", () => {
  it("empty text → no-op, state unchanged", async () => {
    const ctrl = new WsChatController();
    await ctrl.sendMessage("   ");
    expect(ctrl.getState().messages).toHaveLength(0);
  });

  it("turnState streaming → no-op", async () => {
    const ctrl = new WsChatController();
    ctrl.connect();
    FakeWebSocket.last!.open();

    // Start a turn.
    const p = ctrl.sendMessage("first");
    // Immediately try to send another.
    await ctrl.sendMessage("second");
    // Only one user message should exist.
    const userMsgs = ctrl.getState().messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);

    // Clean up — simulate done so first turn completes.
    FakeWebSocket.last!.receive({ type: "done" });
    await p;
  });
});

// ── sendMessage happy path ────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("adds user + assistant placeholder, turnState → streaming", async () => {
    const ctrl = new WsChatController();
    ctrl.connect();
    FakeWebSocket.last!.open();

    const p = ctrl.sendMessage("hello");
    const state = ctrl.getState();

    expect(state.turnState).toBe("streaming");
    expect(state.messages.find((m) => m.role === "user")?.content).toBe(
      "hello",
    );
    expect(state.messages.find((m) => m.role === "assistant")?.streaming).toBe(
      true,
    );

    FakeWebSocket.last!.receive({ type: "done" });
    await p;
  });

  it('sends { type: "turn", message } frame to WebSocket', async () => {
    const ctrl = new WsChatController();
    ctrl.connect();
    FakeWebSocket.last!.open();

    const p = ctrl.sendMessage("make it blue");
    expect(FakeWebSocket.last!.sent).toHaveLength(1);
    const frame = JSON.parse(FakeWebSocket.last!.sent[0]) as {
      type: string;
      message: string;
    };
    expect(frame).toEqual({ type: "turn", message: "make it blue" });

    FakeWebSocket.last!.receive({ type: "done" });
    await p;
  });
});

// ── onmessage frame handlers ──────────────────────────────────────────────────

describe("onmessage handlers", () => {
  async function setup() {
    const ctrl = new WsChatController();
    ctrl.connect();
    const ws = FakeWebSocket.last!;
    ws.open();
    const p = ctrl.sendMessage("test");
    return { ctrl, ws, p };
  }

  it("chunk frame → appends text to assistant message", async () => {
    const { ctrl, ws, p } = await setup();
    ws.receive({ type: "chunk", text: "Hello " });
    ws.receive({ type: "chunk", text: "world" });
    ws.receive({ type: "done" });
    await p;
    const assistant = ctrl
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Hello world");
  });

  it("done frame → streaming false, turnState idle", async () => {
    const { ctrl, ws, p } = await setup();
    ws.receive({ type: "done" });
    await p;
    const state = ctrl.getState();
    expect(state.turnState).toBe("idle");
    const assistant = state.messages.find((m) => m.role === "assistant");
    expect(assistant?.streaming).toBe(false);
  });

  it("error frame → appends error content, turnState error", async () => {
    const { ctrl, ws, p } = await setup();
    ws.receive({ type: "error", message: "spawn failed" });
    await p;
    const state = ctrl.getState();
    expect(state.turnState).toBe("error");
    const assistant = state.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toContain("spawn failed");
    expect(assistant?.streaming).toBe(false);
  });

  it("invalid JSON frame → silently ignored", async () => {
    const { ctrl, ws, p } = await setup();
    ws.onmessage?.({ data: "not-json" });
    ws.receive({ type: "done" });
    await p;
    // No crash, turn completed normally.
    expect(ctrl.getState().turnState).toBe("idle");
  });
});

// ── onerror ───────────────────────────────────────────────────────────────────

describe("onerror", () => {
  it("WebSocket error → turnState error", () => {
    const ctrl = new WsChatController();
    ctrl.connect();
    FakeWebSocket.last!.error();
    expect(ctrl.getState().turnState).toBe("error");
  });
});

// ── clearError ────────────────────────────────────────────────────────────────

describe("clearError", () => {
  it("error → idle", () => {
    const ctrl = new WsChatController();
    ctrl.connect();
    FakeWebSocket.last!.error();
    ctrl.clearError();
    expect(ctrl.getState().turnState).toBe("idle");
  });

  it("idle → still idle (no-op)", () => {
    const ctrl = new WsChatController();
    ctrl.clearError();
    expect(ctrl.getState().turnState).toBe("idle");
  });
});

// ── disconnect ────────────────────────────────────────────────────────────────

describe("disconnect", () => {
  it("closes WebSocket", () => {
    const ctrl = new WsChatController();
    ctrl.connect();
    const ws = FakeWebSocket.last!;
    ctrl.disconnect();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
