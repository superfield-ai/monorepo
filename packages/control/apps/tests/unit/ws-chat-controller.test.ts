/**
 * Unit tests for WsChatController in a real Chromium browser env.
 *
 * Strategy: stub the global `WebSocket` constructor with a controllable fake
 * that supports `addEventListener` (the surface `openWebSocket` consumes), and
 * pass synchronous timer seams to the controller so reconnect timers are
 * deterministic. Each fake socket is exposed via a tracker so tests can fire
 * open / message / close / error events directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WsChatController,
  type WsChatControllerOptions,
} from "../../src/controllers/ChatController";

interface SimpleFake {
  url: string;
  sent: string[];
  closed: boolean;
  fireOpen(): void;
  fireMessage(frame: object): void;
  fireRawMessage(data: string): void;
  fireClose(opts?: { wasClean?: boolean; code?: number }): void;
  fireError(): void;
}

interface Tracker {
  last: SimpleFake | null;
  history: SimpleFake[];
}

interface FakeTimers {
  setTimer: WsChatControllerOptions["setTimer"];
  clearTimer: WsChatControllerOptions["clearTimer"];
  pending: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  runNext(): number | undefined;
}

function createFakeTimers(): FakeTimers {
  const pending: FakeTimers["pending"] = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const e = { fn, ms, cancelled: false };
      pending.push(e);
      return e;
    },
    clearTimer: (h: unknown) => {
      if (h && typeof h === "object")
        (h as { cancelled: boolean }).cancelled = true;
    },
    runNext() {
      while (pending.length > 0) {
        const e = pending.shift()!;
        if (e.cancelled) continue;
        e.fn();
        return e.ms;
      }
      return undefined;
    },
  };
}

function makeHarness(
  options: Omit<
    WsChatControllerOptions,
    "openSocket" | "setTimer" | "clearTimer"
  > = {},
): {
  ctrl: WsChatController;
  openSocket: Tracker;
  timers: FakeTimers;
} {
  const tracker: Tracker = { last: null, history: [] };
  const timers = createFakeTimers();

  class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeWS.CONNECTING;
    listeners = new Map<string, Set<(ev: unknown) => void>>();
    sent: string[] = [];

    constructor(public url: string) {
      const fake: SimpleFake = {
        url,
        sent: this.sent,
        closed: false,
        fireOpen: () => {
          this.readyState = FakeWS.OPEN;
          this.dispatch("open", {});
        },
        fireMessage: (frame) => {
          this.dispatch("message", { data: JSON.stringify(frame) });
        },
        fireRawMessage: (data) => {
          this.dispatch("message", { data });
        },
        fireClose: (opts = {}) => {
          this.readyState = FakeWS.CLOSED;
          this.dispatch("close", {
            wasClean: opts.wasClean ?? false,
            code: opts.code ?? 1006,
            reason: "",
          });
        },
        fireError: () => {
          this.dispatch("error", {});
          this.readyState = FakeWS.CLOSED;
          this.dispatch("close", { wasClean: false, code: 1006, reason: "" });
        },
      };
      tracker.last = fake;
      tracker.history.push(fake);
    }
    addEventListener(t: string, h: (ev: unknown) => void) {
      if (!this.listeners.has(t)) this.listeners.set(t, new Set());
      this.listeners.get(t)!.add(h);
    }
    removeEventListener(t: string, h: (ev: unknown) => void) {
      this.listeners.get(t)?.delete(h);
    }
    dispatch(t: string, ev: object) {
      this.listeners.get(t)?.forEach((fn) => fn(ev));
    }
    send(data: string) {
      this.sent.push(data);
    }
    close(code = 1000) {
      this.readyState = FakeWS.CLOSED;
      const fake = tracker.history[tracker.history.length - 1];
      if (fake) fake.closed = true;
      this.dispatch("close", { wasClean: true, code, reason: "" });
    }
  }

  vi.stubGlobal("WebSocket", FakeWS);

  const ctrl = new WsChatController({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...options,
  });

  return { ctrl, openSocket: tracker, timers };
}

beforeEach(() => {
  vi.stubGlobal("crypto", {
    randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}`,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Initial state ─────────────────────────────────────────────────────────────

describe("initial state", () => {
  it("connState idle, turnState idle, messages empty, no error", () => {
    const { ctrl } = makeHarness();
    expect(ctrl.getState()).toEqual({
      turnState: "idle",
      messages: [],
      connState: "idle",
      reconnectAttempt: 0,
      lastError: null,
    });
  });
});

// ── connect / state machine ───────────────────────────────────────────────────

describe("connect", () => {
  it("transitions idle → connecting → open", () => {
    const { ctrl, openSocket } = makeHarness();
    ctrl.connect();
    expect(ctrl.getState().connState).toBe("connecting");
    openSocket.last!.fireOpen();
    expect(ctrl.getState().connState).toBe("open");
  });

  it("opens exactly one socket when called twice while open", () => {
    const { ctrl, openSocket } = makeHarness();
    ctrl.connect();
    openSocket.last!.fireOpen();
    ctrl.connect();
    expect(openSocket.history).toHaveLength(1);
  });
});

// ── reconnect state machine ───────────────────────────────────────────────────

describe("reconnect", () => {
  it("unclean close → reconnecting + scheduled timer with backoff[0]", () => {
    const { ctrl, openSocket, timers } = makeHarness({
      backoffMs: [10, 20, 40],
      maxReconnectAttempts: 3,
    });
    ctrl.connect();
    openSocket.last!.fireOpen();
    openSocket.last!.fireClose({ wasClean: false });
    expect(ctrl.getState().connState).toBe("reconnecting");
    expect(ctrl.getState().reconnectAttempt).toBe(1);
    expect(timers.pending[0]?.ms).toBe(10);
  });

  it("running the timer reopens a new socket", () => {
    const { ctrl, openSocket, timers } = makeHarness({
      backoffMs: [10],
      maxReconnectAttempts: 3,
    });
    ctrl.connect();
    openSocket.last!.fireOpen();
    openSocket.last!.fireClose({ wasClean: false });
    timers.runNext();
    expect(openSocket.history.length).toBe(2);
    // Mid-reconnect the controller stays in "reconnecting" until handleOpen.
    expect(ctrl.getState().connState).toBe("reconnecting");
    openSocket.last!.fireOpen();
    expect(ctrl.getState().connState).toBe("open");
    expect(ctrl.getState().reconnectAttempt).toBe(0);
  });

  it("exhausting maxReconnectAttempts → failed", () => {
    const { ctrl, openSocket, timers } = makeHarness({
      backoffMs: [1],
      maxReconnectAttempts: 2,
    });
    ctrl.connect();
    openSocket.last!.fireOpen();
    openSocket.last!.fireClose({ wasClean: false });
    timers.runNext();
    openSocket.last!.fireClose({ wasClean: false });
    timers.runNext();
    openSocket.last!.fireClose({ wasClean: false });
    expect(ctrl.getState().connState).toBe("failed");
  });

  it("reconnectNow resets attempt and reopens", () => {
    const { ctrl, openSocket, timers } = makeHarness({
      backoffMs: [1],
      maxReconnectAttempts: 1,
    });
    ctrl.connect();
    openSocket.last!.fireOpen();
    openSocket.last!.fireClose({ wasClean: false });
    timers.runNext();
    openSocket.last!.fireClose({ wasClean: false });
    expect(ctrl.getState().connState).toBe("failed");
    ctrl.reconnectNow();
    expect(openSocket.history.length).toBeGreaterThanOrEqual(3);
    expect(ctrl.getState().reconnectAttempt).toBe(0);
  });
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe("subscribe", () => {
  it("listener called immediately with current state", () => {
    const { ctrl } = makeHarness();
    const calls: unknown[] = [];
    ctrl.subscribe((s) => calls.push(s));
    expect(calls).toHaveLength(1);
    expect((calls[0] as { connState: string }).connState).toBe("idle");
  });

  it("returns unsubscribe function that stops future notifications", () => {
    const { ctrl } = makeHarness();
    let count = 0;
    const unsub = ctrl.subscribe(() => count++);
    unsub();
    ctrl.connect();
    expect(count).toBe(1);
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("empty text → no-op", async () => {
    const { ctrl } = makeHarness();
    await ctrl.sendMessage("   ");
    expect(ctrl.getState().messages).toHaveLength(0);
  });

  it("turnState streaming → no-op", async () => {
    const { ctrl, openSocket } = makeHarness();
    ctrl.connect();
    openSocket.last!.fireOpen();
    const p = ctrl.sendMessage("first");
    await ctrl.sendMessage("second");
    const userMsgs = ctrl.getState().messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    openSocket.last!.fireMessage({ type: "done" });
    await p;
  });

  it("adds user + assistant placeholder, turnState streaming", async () => {
    const { ctrl, openSocket } = makeHarness();
    ctrl.connect();
    openSocket.last!.fireOpen();
    const p = ctrl.sendMessage("hello");
    const state = ctrl.getState();
    expect(state.turnState).toBe("streaming");
    expect(state.messages.find((m) => m.role === "user")?.content).toBe(
      "hello",
    );
    expect(state.messages.find((m) => m.role === "assistant")?.streaming).toBe(
      true,
    );
    openSocket.last!.fireMessage({ type: "done" });
    await p;
  });

  it('sends { type: "turn", message } frame', async () => {
    const { ctrl, openSocket } = makeHarness();
    ctrl.connect();
    openSocket.last!.fireOpen();
    const p = ctrl.sendMessage("make it blue");
    expect(openSocket.last!.sent[0]).toBeDefined();
    const frame = JSON.parse(openSocket.last!.sent[0]!) as {
      type: string;
      message: string;
    };
    expect(frame).toEqual({ type: "turn", message: "make it blue" });
    openSocket.last!.fireMessage({ type: "done" });
    await p;
  });
});

// ── frame handlers ────────────────────────────────────────────────────────────

describe("frame handlers", () => {
  async function setup() {
    const h = makeHarness();
    h.ctrl.connect();
    h.openSocket.last!.fireOpen();
    const p = h.ctrl.sendMessage("test");
    return { ...h, p };
  }

  it("chunk frames append text", async () => {
    const { ctrl, openSocket, p } = await setup();
    openSocket.last!.fireMessage({ type: "chunk", text: "Hello " });
    openSocket.last!.fireMessage({ type: "chunk", text: "world" });
    openSocket.last!.fireMessage({ type: "done" });
    await p;
    const a = ctrl.getState().messages.find((m) => m.role === "assistant");
    expect(a?.content).toBe("Hello world");
  });

  it("done frame settles turn", async () => {
    const { ctrl, openSocket, p } = await setup();
    openSocket.last!.fireMessage({ type: "done" });
    await p;
    expect(ctrl.getState().turnState).toBe("idle");
  });

  it("error frame surfaces in message + turnState", async () => {
    const { ctrl, openSocket, p } = await setup();
    openSocket.last!.fireMessage({ type: "error", message: "spawn failed" });
    await p;
    const state = ctrl.getState();
    expect(state.turnState).toBe("error");
    expect(
      state.messages.find((m) => m.role === "assistant")?.content,
    ).toContain("spawn failed");
  });

  it("invalid JSON ignored", async () => {
    const { ctrl, openSocket, p } = await setup();
    openSocket.last!.fireRawMessage("not-json");
    openSocket.last!.fireMessage({ type: "done" });
    await p;
    expect(ctrl.getState().turnState).toBe("idle");
  });
});

// ── mid-turn drop ─────────────────────────────────────────────────────────────

describe("mid-turn drop", () => {
  it("unclean close during a turn sets turnState error", async () => {
    const { ctrl, openSocket } = makeHarness({
      backoffMs: [1],
      maxReconnectAttempts: 1,
    });
    ctrl.connect();
    openSocket.last!.fireOpen();
    void ctrl.sendMessage("hello");
    openSocket.last!.fireClose({ wasClean: false });
    expect(ctrl.getState().turnState).toBe("error");
  });
});

// ── clearError ────────────────────────────────────────────────────────────────

describe("clearError", () => {
  it("error → idle", async () => {
    const { ctrl, openSocket } = makeHarness();
    ctrl.connect();
    openSocket.last!.fireOpen();
    void ctrl.sendMessage("hi");
    openSocket.last!.fireMessage({ type: "error", message: "boom" });
    ctrl.clearError();
    expect(ctrl.getState().turnState).toBe("idle");
  });

  it("idle → still idle", () => {
    const { ctrl } = makeHarness();
    ctrl.clearError();
    expect(ctrl.getState().turnState).toBe("idle");
  });
});

// ── disconnect ────────────────────────────────────────────────────────────────

describe("disconnect", () => {
  it("closes socket and sets connState idle", () => {
    const { ctrl, openSocket } = makeHarness();
    ctrl.connect();
    openSocket.last!.fireOpen();
    ctrl.disconnect();
    expect(ctrl.getState().connState).toBe("idle");
    expect(openSocket.last!.closed).toBe(true);
  });

  it("does not schedule a reconnect after manual disconnect", () => {
    const { ctrl, openSocket, timers } = makeHarness({
      backoffMs: [10],
      maxReconnectAttempts: 3,
    });
    ctrl.connect();
    openSocket.last!.fireOpen();
    ctrl.disconnect();
    expect(timers.pending.filter((t) => !t.cancelled)).toHaveLength(0);
  });
});
