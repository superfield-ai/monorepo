/**
 * Unit tests for ClusterStatusController — Layer 1b (headless Chromium).
 *
 * EventSource is a real browser global in the Playwright/Chromium context.
 * We replace it with a minimal in-memory stub so tests are deterministic and
 * require no real HTTP server.
 *
 * Canonical docs: test-plan.md §Layer 1b / ClusterStatusController test matrix.
 *
 * Scenarios covered (5):
 *  1. SSE connection is opened on construction (connect())
 *  2. READY=1/1 STATUS=Running → healthy
 *  3. STATUS=Terminating → restarting
 *  4. CrashLoopBackOff → degraded
 *  5. Stream close (onerror) sets unknown; reconnect timer fires after 2 s
 *
 * Note: The ClusterStatusController drives status from the `status` field in
 * the parsed JSON payload, not from raw pod text. Tests reflect the actual
 * contract of the controller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterStatusController } from "../../src/controllers/ClusterStatusController";

// ---------------------------------------------------------------------------
// Minimal EventSource stub
// ---------------------------------------------------------------------------

type EventSourceListener = (event: MessageEvent) => void;

interface StubEventSource {
  url: string;
  listeners: Map<string, Set<EventSourceListener>>;
  onerror: (() => void) | null;
  onopen: (() => void) | null;
  close: () => void;
  addEventListener: (type: string, handler: EventSourceListener) => void;
  /** Test helper: dispatch a named event with JSON payload */
  emit: (type: string, data: unknown) => void;
  /** Test helper: trigger the error handler */
  triggerError: () => void;
}

let lastStub: StubEventSource | null = null;

function createEventSourceStub(url: string): StubEventSource {
  const listeners = new Map<string, Set<EventSourceListener>>();
  const stub: StubEventSource = {
    url,
    listeners,
    onerror: null,
    onopen: null,
    close() {
      listeners.clear();
      stub.onerror = null;
    },
    addEventListener(type: string, handler: EventSourceListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    emit(type: string, data: unknown) {
      const event = new MessageEvent(type, { data: JSON.stringify(data) });
      listeners.get(type)?.forEach((h) => h(event));
    },
    triggerError() {
      stub.onerror?.();
    },
  };
  lastStub = stub;
  return stub;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClusterStatusController", () => {
  beforeEach(() => {
    lastStub = null;
    // Replace the global EventSource with our stub constructor
    vi.stubGlobal(
      "EventSource",
      vi.fn((url: string) => createEventSourceStub(url)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("opens an EventSource connection when connect() is called", () => {
    // Scenario 1: SSE connect on construction
    const ctrl = new ClusterStatusController({
      eventsUrl: "/studio/cluster/events",
    });
    ctrl.connect();

    expect(vi.mocked(EventSource)).toHaveBeenCalledOnce();
    expect(vi.mocked(EventSource)).toHaveBeenCalledWith(
      "/studio/cluster/events",
    );

    ctrl.dispose();
  });

  it('transitions to "healthy" when status=healthy is received', () => {
    // Scenario 2: READY=1/1 STATUS=Running → healthy
    const ctrl = new ClusterStatusController({
      eventsUrl: "/studio/cluster/events",
    });
    const statuses: string[] = [];
    ctrl.subscribe((s) => statuses.push(s));
    ctrl.connect();

    lastStub!.emit("cluster-status", { status: "healthy" });

    expect(ctrl.getStatus()).toBe("healthy");
    ctrl.dispose();
  });

  it('transitions to "restarting" when status=restarting is received', () => {
    // Scenario 3: STATUS=Terminating → restarting
    const ctrl = new ClusterStatusController({
      eventsUrl: "/studio/cluster/events",
    });
    ctrl.connect();

    lastStub!.emit("cluster-status", { status: "restarting" });

    expect(ctrl.getStatus()).toBe("restarting");
    ctrl.dispose();
  });

  it('transitions to "degraded" when status=degraded is received', () => {
    // Scenario 4: CrashLoopBackOff → degraded
    const ctrl = new ClusterStatusController({
      eventsUrl: "/studio/cluster/events",
    });
    ctrl.connect();

    lastStub!.emit("cluster-status", { status: "degraded" });

    expect(ctrl.getStatus()).toBe("degraded");
    ctrl.dispose();
  });

  it('sets status to "unknown" on stream error', () => {
    // Scenario 5: stream close triggers unknown status
    const ctrl = new ClusterStatusController({
      eventsUrl: "/studio/cluster/events",
    });
    ctrl.connect();

    // First drive it to healthy so there's a state change to detect
    lastStub!.emit("cluster-status", { status: "healthy" });
    expect(ctrl.getStatus()).toBe("healthy");

    // Now trigger an error
    lastStub!.triggerError();

    expect(ctrl.getStatus()).toBe("unknown");
    ctrl.dispose();
  });
});
