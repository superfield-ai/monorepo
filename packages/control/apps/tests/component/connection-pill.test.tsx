/**
 * Component tests for ConnectionPill.
 *
 * Drives a WsChatController via its test seams (stubbed WebSocket + setTimer)
 * and asserts the pill's visible state through every connState transition.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
import { ConnectionPill } from "../../src/components/ConnectionPill";
import { WsChatController } from "../../src/controllers/ChatController";

interface SimpleFake {
  fireOpen(): void;
  fireClose(opts?: { wasClean?: boolean }): void;
  closed: boolean;
}

interface Tracker {
  last: SimpleFake | null;
  history: SimpleFake[];
}

function installFakeSocket(): Tracker {
  const tracker: Tracker = { last: null, history: [] };
  class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeWS.CONNECTING;
    listeners = new Map<string, Set<(ev: unknown) => void>>();
    constructor(_url: string) {
      const fake: SimpleFake = {
        closed: false,
        fireOpen: () => {
          this.readyState = FakeWS.OPEN;
          this.dispatch("open", {});
        },
        fireClose: (opts = {}) => {
          this.readyState = FakeWS.CLOSED;
          this.dispatch("close", {
            wasClean: opts.wasClean ?? false,
            code: 1006,
            reason: "",
          });
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
    send(_data: string) {}
    close() {
      this.readyState = FakeWS.CLOSED;
      const fake = tracker.history[tracker.history.length - 1];
      if (fake) fake.closed = true;
      this.dispatch("close", { wasClean: true, code: 1000, reason: "" });
    }
  }
  vi.stubGlobal("WebSocket", FakeWS);
  return tracker;
}

let pendingTimers: Array<{ fn: () => void; cancelled: boolean }> = [];
const setTimer = (fn: () => void) => {
  const e = { fn, cancelled: false };
  pendingTimers.push(e);
  return e;
};
const clearTimer = (h: unknown) => {
  if (h && typeof h === "object")
    (h as { cancelled: boolean }).cancelled = true;
};
function runNextTimer() {
  while (pendingTimers.length > 0) {
    const e = pendingTimers.shift()!;
    if (!e.cancelled) {
      e.fn();
      return;
    }
  }
}

beforeEach(() => {
  pendingTimers = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectionPill", () => {
  it("renders nothing while idle", () => {
    installFakeSocket();
    const ctrl = new WsChatController({ setTimer, clearTimer });
    const screen = render(<ConnectionPill controller={ctrl} />);
    expect(
      screen.container.querySelector('[data-testid="connection-pill"]'),
    ).toBeNull();
  });

  it("renders 'Connecting…' on connect()", async () => {
    const tracker = installFakeSocket();
    const ctrl = new WsChatController({ setTimer, clearTimer });
    const screen = render(<ConnectionPill controller={ctrl} />);
    ctrl.connect();
    await flush();
    expect(
      screen.container
        .querySelector('[data-testid="connection-pill"]')
        ?.getAttribute("data-state"),
    ).toBe("connecting");
    tracker.last!.fireOpen();
    await flush();
    expect(
      screen.container.querySelector('[data-testid="connection-pill"]'),
    ).toBeNull();
  });

  it("renders 'Reconnecting…' after unclean close", async () => {
    const tracker = installFakeSocket();
    const ctrl = new WsChatController({
      setTimer,
      clearTimer,
      backoffMs: [10],
      maxReconnectAttempts: 3,
    });
    const screen = render(<ConnectionPill controller={ctrl} />);
    ctrl.connect();
    tracker.last!.fireOpen();
    tracker.last!.fireClose({ wasClean: false });
    await flush();
    const pill = screen.container.querySelector(
      '[data-testid="connection-pill"]',
    );
    expect(pill?.getAttribute("data-state")).toBe("reconnecting");
    expect(pill?.textContent).toContain("attempt 1");
  });

  it("shows Reconnect now button after exhausting attempts; clicking it retries", async () => {
    const tracker = installFakeSocket();
    const ctrl = new WsChatController({
      setTimer,
      clearTimer,
      backoffMs: [1],
      maxReconnectAttempts: 1,
    });
    const screen = render(<ConnectionPill controller={ctrl} />);
    ctrl.connect();
    tracker.last!.fireOpen();
    tracker.last!.fireClose({ wasClean: false });
    runNextTimer();
    tracker.last!.fireClose({ wasClean: false });
    await flush();
    const pill = screen.container.querySelector(
      '[data-testid="connection-pill"]',
    );
    expect(pill?.getAttribute("data-state")).toBe("failed");
    const btn = pill?.querySelector("button") as HTMLButtonElement | null;
    expect(btn?.textContent).toContain("RECONNECT NOW");
    btn?.click();
    await flush();
    expect(ctrl.getState().connState).not.toBe("failed");
  });
});
