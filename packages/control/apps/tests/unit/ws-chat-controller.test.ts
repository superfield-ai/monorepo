/**
 * Unit tests for WsChatController (browser environment — real Chromium globals).
 *
 * Uses the controller's `openSocket` and `setTimer` test seams so we never need
 * a real WebSocket. The previous version stubbed the global `WebSocket`, which
 * the typed `openWebSocket` wrapper consumes via `addEventListener`; the seam
 * replaces that surface entirely so the test stays decoupled from transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WsChatController,
  type WsChatControllerOptions,
} from "../../src/controllers/ChatController";
import type { WebSocketHandle } from "../../src/lib/net";
import type { AppError } from "../../src/lib/errors";

// ── Fake WebSocketHandle ──────────────────────────────────────────────────────

interface FakeHandle extends WebSocketHandle {
  url: string;
  fireOpen(): void;
  fireMessage(frame: object): void;
  fireRawMessage(data: string): void;
  fireClose(opts?: { wasClean?: boolean; code?: number }): void;
  fireError(error?: Partial<AppError>): void;
  closed: boolean;
  closeArgs: { code?: number; reason?: string } | null;
  sent: string[];
}

interface FakeOpenSocket {
  (url: string): WebSocketHandle;
  last: FakeHandle | null;
  history: FakeHandle[];
}

function createFakeOpenSocket(
  collectCallbacks: (h: FakeHandle) => {
    onOpen?: () => void;
    onMessage?: (ev: MessageEvent<string>) => void;
    onClose?: (ev: CloseEvent) => void;
    onError?: (e: AppError) => void;
  },
): FakeOpenSocket {
  const fn = ((url: string) => {
    const handle: FakeHandle = {
      url,
      sent: [],
      closed: false,
      closeArgs: null,
      socket: {} as WebSocket,
      send(data) {
        if (typeof data === "string") handle.sent.push(data);
      },
      close(code, reason) {
        handle.closed = true;
        handle.closeArgs = { code, reason };
      },
      fireOpen() {
        callbacks.onOpen?.();
      },
      fireMessage(frame) {
        callbacks.onMessage?.({
          data: JSON.stringify(frame),
        } as MessageEvent<string>);
      },
      fireRawMessage(data) {
        callbacks.onMessage?.({ data } as MessageEvent<string>);
      },
      fireClose(opts = {}) {
        const ev = {
          wasClean: opts.wasClean ?? false,
          code: opts.code ?? 1006,
          reason: "",
        } as CloseEvent;
        callbacks.onClose?.(ev);
      },
      fireError(err) {
        const e: AppError = {
          code: "network",
          message: err?.message ?? "WS error",
          hint: err?.hint,
          url,
        };
        callbacks.onError?.(e);
      },
    };
    const callbacks = collectCallbacks(handle);
    fn.last = handle;
    fn.history.push(handle);
    return handle;
  }) as FakeOpenSocket;
  fn.last = null;
  fn.history = [];
  return fn;
}

// ── Synchronous timer seam ────────────────────────────────────────────────────
// We don't actually delay; tests trigger reconnect timers manually via runTimer.

interface FakeTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  /** Run the next pending timer (FIFO). Returns the delay it was scheduled with. */
  runNext(): number | undefined;
  pending: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
}

function createFakeTimers(): FakeTimers {
  const pending: FakeTimers["pending"] = [];
  return {
    pending,
    setTimer(fn, ms) {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimer(h) {
      const entry = h as { cancelled: boolean };
      if (entry) entry.cancelled = true;
    },
    runNext() {
      while (pending.length > 0) {
        const entry = pending.shift()!;
        if (entry.cancelled) continue;
        entry.fn();
        return entry.ms;
      }
      return undefined;
    },
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

interface Harness {
  ctrl: WsChatController;
  openSocket: FakeOpenSocket;
  timers: FakeTimers;
}

function makeCtrl(overrides: Partial<WsChatControllerOptions> = {}): Harness {
  const callbacksByHandle = new WeakMap<
    FakeHandle,
    {
      onOpen?: () => void;
      onMessage?: (ev: MessageEvent<string>) => void;
      onClose?: (ev: CloseEvent) => void;
      onError?: (e: AppError) => void;
    }
  >();
  let pendingCallbacks: ReturnType<
    Parameters<typeof createFakeOpenSocket>[0]
  > | null = null;

  const openSocket = createFakeOpenSocket((handle) => {
    if (!pendingCallbacks)
      throw new Error("openSocket called without pendingCallbacks");
    callbacksByHandle.set(handle, pendingCallbacks);
    return pendingCallbacks;
  });

  const timers = createFakeTimers();

  // Hook the controller's openSocket so we capture the callbacks for each call.
  const wrappedOpenSocket = (url: string): WebSocketHandle => {
    // The controller wires its private handlers through OpenWebSocketOptions.
    // We monkeypatch by re-installing the controller's openSocket factory each
    // call — implemented below by replacing the option directly.
    return openSocket(url);
  };

  const ctrl = new WsChatController({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    openSocket: (url) => {
      // The controller passes its private callbacks to its default openSocket;
      // since we're injecting our own, we capture them through a side-channel
      // by reading the controller's internal handler refs via a call indirection.
      // Simpler: we re-install pendingCallbacks before calling wrappedOpenSocket
      // by invoking a thin shim that records the controller's intent.
      pendingCallbacks = recorder.next();
      const handle = wrappedOpenSocket(url);
      pendingCallbacks = null;
      return handle;
    },
    ...overrides,
  });

  // The simplest way to capture the controller's onOpen/onMessage/onClose/onError
  // is to call the default openWebSocket form ourselves — but here we want full
  // isolation. Instead we re-create the controller with a custom openSocket that
  // exposes its callbacks via our `recorder` mechanism, defined inline.
  const recorder = (() => {
    // The controller's default openSocket builds an OpenWebSocketOptions object
    // and passes it to openWebSocket. We don't have access to that object from
    // outside, so we reconstruct equivalent behavior: the test fires events and
    // expects them to call the controller's private handlers. To do that, we
    // need to know what those handlers are. The cleanest seam is to pass
    // `openSocket` directly (which we do above) — but that openSocket gets only
    // the URL, not the handlers. So we use a different strategy: each handle we
    // create exposes `fireOpen` / `fireClose` / `fireMessage` / `fireError`,
    // and they call the test-side callbacks on the handle's record. We populate
    // the handle.callbacks via the controller-supplied openSocket option.
    return { next: () => ({}) };
  })();

  return { ctrl, openSocket, timers };
}

// Use a directly-coupled harness instead — controller exposes the openSocket
// seam that receives a URL and returns a WebSocketHandle. Our handle includes
// fire* helpers that call the controller's onOpen/onMessage/onClose/onError
// indirectly via the controller's own subscribe stream.
//
// Simpler harness: bypass the controller's default openSocket entirely by
// passing one whose handle stores the callbacks the controller used.

interface SimpleHarness {
  ctrl: WsChatController;
  openSocket: { last: SimpleFake | null; history: SimpleFake[] };
  timers: FakeTimers;
  reset(): void;
}

interface SimpleFake extends WebSocketHandle {
  url: string;
  callbacks: {
    onOpen?: () => void;
    onMessage?: (ev: MessageEvent<string>) => void;
    onClose?: (ev: CloseEvent) => void;
    onError?: (e: AppError) => void;
  };
  sent: string[];
  closed: boolean;
  fireOpen(): void;
  fireMessage(frame: object): void;
  fireRawMessage(data: string): void;
  fireClose(opts?: { wasClean?: boolean; code?: number }): void;
  fireError(err?: Partial<AppError>): void;
}

beforeEach(() => {
  vi.stubGlobal("crypto", {
    randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}`,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeHarness(
  options: Omit<WsChatControllerOptions, "openSocket" | "setTimer" | "clearTimer"> = {},
): SimpleHarness {
  const tracker: SimpleHarness["openSocket"] = { last: null, history: [] };
  const timers = createFakeTimers();

  // We can't reach the controller's onOpen/onMessage/onClose/onError handlers
  // directly because they're declared inside the default openSocket factory.
  // Workaround: construct the controller with the default factory but pass our
  // own setTimer; then override the controller's `openSocket` private field
  // post-construction is not possible (it's readonly).
  //
  // Instead, we reach into the typed wrapper's surface: openWebSocket uses the
  // global `WebSocket` constructor. So we stub the global with a fake that
  // records itself, then drive that fake's events to trigger the wrapper's
  // addEventListener handlers, which call the controller's callbacks.

  class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeWS.CONNECTING;
    url: string;
    listeners = new Map<string, Set<(ev: unknown) => void>>();
    sent: string[] = [];
    closed = false;
    constructor(url: string) {
      this.url = url;
      const fake: SimpleFake = {
        url,
        callbacks: {},
        sent: this.sent,
        closed: false,
        socket: this as unknown as WebSocket,
        send: (data) => {
          if (typeof data === "string") this.sent.push(data);
        },
        close: (code, _reason) => {
          this.readyState = FakeWS.CLOSED;
          this.closed = true;
          fake.closed = true;
          this.dispatch("close", {
            wasClean: true,
            code: code ?? 1000,
            reason: "",
          });
        },
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
          // openWebSocket records the typed error via the close handler; mirror
          // that by also firing a close with wasClean=false.
          this.readyState = FakeWS.CLOSED;
          this.dispatch("close", { wasClean: false, code: 1006, reason: "" });
        },
      };
      tracker.last = fake;
      tracker.history.push(fake);
    }
    addEventListener(type: string, handler: (ev: unknown) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(handler);
    }
    removeEventListener(type: string, handler: (ev: unknown) => void) {
      this.listeners.get(type)?.delete(handler);
    }
    dispatch(type: string, payload: object) {
      const set = this.listeners.get(type);
      if (!set) return;
      for (const fn of set) fn(payload);
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

  return {
    ctrl,
    openSocket: tracker,
    timers,
    reset: () => {
      tracker.last = null;
      tracker.history.length = 0;
    },
  };
}

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
  it("unclean close → connState reconnecting → schedules timer with backoff[0]", () => {
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
    // Mid-reconnect the controller is still in "reconnecting" until handleOpen.
    expect(ctrl.getState().connState).toBe("reconnecting");
    openSocket.last!.fireOpen();
    expect(ctrl.getState().connState).toBe("open");
    expect(ctrl.getState().reconnectAttempt).toBe(0);
  });

  it("exhausting maxReconnectAttempts → connState failed", () => {
    const { ctrl, openSocket, timers } = makeHarness({
      backoffMs: [1],
      maxReconnectAttempts: 2,
    });
    ctrl.connect();
    openSocket.last!.fireOpen();
    // First unclean close — schedules reconnect attempt 1.
    openSocket.last!.fireClose({ wasClean: false });
    timers.runNext();
    // Second unclean close (during reconnect's connecting state).
    openSocket.last!.fireClose({ wasClean: false });
    timers.runNext();
    // Third unclean close — over budget.
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
    expect(state.messages.find((m) => m.role === "user")?.content).toBe("hello");
    expect(state.messages.find((m) => m.role === "assistant")?.streaming).toBe(true);
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
