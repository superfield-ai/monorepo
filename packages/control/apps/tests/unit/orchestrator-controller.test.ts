/**
 * Unit tests for OrchestratorController.
 *
 * Covers:
 * - buildHeartbeatHistory: running / idle transitions
 * - buildHeartbeatHistory: done entry when slot disappears
 * - heartbeatHistory reflected in getState()
 * - startDevLoop: processState "starting" → "running" on success
 * - startDevLoop: processState "stopped" + error on non-OK response
 * - stopDevLoop: processState "stopping" → "stopped" on success
 * - stopDevLoop: error on non-OK response
 * - poll: process "running" updates processState
 * - poll: process "stopped" updates processState
 * - poll: loops payload populates loopStatus correctly
 * - poll: non-OK response sets apiReachable false, preserves processState
 * - subscribe: listener notified on each state change from polling
 *
 * Uses stub fetch so no real network calls are made.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { OrchestratorController } from "../../src/controllers/OrchestratorController";

// Minimal fetch stub that resolves empty-ish analytics bodies.
function makeFetchStub(
  slotsPayload: { slots: unknown[] } = { slots: [] },
  options: {
    statusBody?: Record<string, unknown>;
    loopsBody?: Record<string, unknown>;
    startOk?: boolean;
    startReason?: string;
    stopOk?: boolean;
    statusHttpOk?: boolean;
  } = {},
): typeof fetch {
  const {
    statusBody = {
      process: "running",
      pid: 1,
      apiReachable: true,
      uptimeMs: 1000,
    },
    loopsBody = { loops: {} },
    startOk = true,
    startReason,
    stopOk = true,
    statusHttpOk = true,
  } = options;

  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("start")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            startOk
              ? { ok: true }
              : { ok: false, reason: startReason ?? "start failed" },
          ),
      } as Response);
    }
    if (urlStr.includes("stop")) {
      return Promise.resolve({
        ok: stopOk,
        json: () => Promise.resolve({ ok: stopOk }),
      } as Response);
    }
    if (urlStr.includes("status")) {
      return Promise.resolve({
        ok: statusHttpOk,
        json: () => Promise.resolve(statusBody),
      } as Response);
    }
    if (urlStr.includes("loops")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(loopsBody),
      } as Response);
    }
    // slots / default
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(slotsPayload),
    } as Response);
  });
}

describe("OrchestratorController — heartbeat history", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("initial state has empty heartbeatHistory", () => {
    const ctrl = new OrchestratorController();
    expect(ctrl.getState().heartbeatHistory).toEqual({});
  });

  test("running slot with recent heartbeat produces running entry", async () => {
    const now = Date.now();
    globalThis.fetch = makeFetchStub({
      slots: [
        {
          slot: 0,
          issueNumber: 101,
          role: "speculative",
          sessionId: "s1",
          backend: "claude",
          model: "claude-3",
          startedAt: new Date(now - 5000).toISOString(),
          elapsedMs: 5000,
          heartbeatAt: now - 1000, // 1 s ago → running
        },
      ],
    });

    const ctrl = new OrchestratorController();
    // Manually call poll via start/stop cycle — we only need one poll.
    const states: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => states.push(s));
    ctrl.start();

    // Wait for the first poll to complete.
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctrl.stop();
    unsub();

    const lastState = states[states.length - 1];
    const history = lastState.heartbeatHistory["0"];
    expect(history).toBeDefined();
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[history.length - 1].state).toBe("running");
  });

  test("slot with stale heartbeat produces idle entry", async () => {
    const now = Date.now();
    globalThis.fetch = makeFetchStub({
      slots: [
        {
          slot: 1,
          issueNumber: 202,
          role: "primary",
          sessionId: "s2",
          backend: "claude",
          model: "claude-3",
          startedAt: new Date(now - 60000).toISOString(),
          elapsedMs: 60000,
          heartbeatAt: now - 60_000, // 60 s ago → idle
        },
      ],
    });

    const ctrl = new OrchestratorController();
    const states: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => states.push(s));
    ctrl.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctrl.stop();
    unsub();

    const lastState = states[states.length - 1];
    const history = lastState.heartbeatHistory["1"];
    expect(history).toBeDefined();
    expect(history[history.length - 1].state).toBe("idle");
  });

  test("disappearing slot gets done entry on next poll", async () => {
    const now = Date.now();
    // First poll: slot 0 present and running.
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const isSlots = String(url).includes("slots");
      let body: unknown;
      if (String(url).includes("status")) {
        body = { process: "running", pid: 1, apiReachable: true, uptimeMs: 0 };
      } else if (String(url).includes("loops")) {
        body = { loops: {} };
      } else if (isSlots) {
        callCount++;
        body =
          callCount === 1
            ? {
                slots: [
                  {
                    slot: 0,
                    issueNumber: 10,
                    role: "speculative",
                    sessionId: "s",
                    backend: "claude",
                    model: "m",
                    startedAt: new Date(now - 1000).toISOString(),
                    elapsedMs: 1000,
                    heartbeatAt: now - 1000,
                  },
                ],
              }
            : { slots: [] }; // second poll: slot gone
      } else {
        body = { slots: [] };
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    });

    const ctrl = new OrchestratorController({
      statusUrl: "/orchestrator/status",
      loopsUrl: "/analytics/loops",
      slotsUrl: "/analytics/slots",
      logsUrl: "/orchestrator/logs",
      startUrl: "/orchestrator/start",
      stopUrl: "/orchestrator/stop",
    });

    const states: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => states.push(s));

    // Trigger two polls manually by calling start (first immediate poll) then
    // a second poll via the next tick.
    ctrl.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Force a second poll by calling stopDevLoop (which calls poll internally).
    await ctrl.stopDevLoop();
    ctrl.stop();
    unsub();

    // After slot disappears the history for key "0" should include a "done" entry.
    const lastState = states[states.length - 1];
    const history = lastState.heartbeatHistory["0"];
    expect(history).toBeDefined();
    const states_ = history.map((e) => e.state);
    expect(states_).toContain("done");
  });
});

describe("OrchestratorController — process start/stop and loop status", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("startDevLoop sets processState to 'starting' then 'running' on success", async () => {
    globalThis.fetch = makeFetchStub(
      { slots: [] },
      { statusBody: { process: "running", pid: 1, apiReachable: true, uptimeMs: 0 }, startOk: true },
    );

    const ctrl = new OrchestratorController();
    const processStates: string[] = [];
    ctrl.subscribe((s) => processStates.push(s.processState));

    await ctrl.startDevLoop("test-repo");

    // "starting" must appear before "running".
    expect(processStates).toContain("starting");
    const startingIdx = processStates.lastIndexOf("starting");
    const runningIdx = processStates.indexOf("running");
    expect(runningIdx).toBeGreaterThan(startingIdx);
    expect(processStates[processStates.length - 1]).toBe("running");
  });

  test("startDevLoop sets error and 'stopped' state when endpoint returns non-OK body", async () => {
    globalThis.fetch = makeFetchStub(
      { slots: [] },
      { startOk: false, startReason: "already running" },
    );

    const ctrl = new OrchestratorController();
    const states: ReturnType<typeof ctrl.getState>[] = [];
    ctrl.subscribe((s) => states.push(s));

    await ctrl.startDevLoop("test-repo");

    const last = states[states.length - 1];
    expect(last.processState).toBe("stopped");
    expect(last.error).toBe("already running");
  });

  test("stopDevLoop sets processState to 'stopping' then 'stopped' on success", async () => {
    globalThis.fetch = makeFetchStub(
      { slots: [] },
      { statusBody: { process: "stopped", pid: null, apiReachable: true, uptimeMs: 0 }, stopOk: true },
    );

    const ctrl = new OrchestratorController();
    const processStates: string[] = [];
    ctrl.subscribe((s) => processStates.push(s.processState));

    await ctrl.stopDevLoop();

    // "stopping" must appear before "stopped" in the transition sequence.
    expect(processStates).toContain("stopping");
    const stoppingIdx = processStates.indexOf("stopping");
    const stoppedIdx = processStates.lastIndexOf("stopped");
    expect(stoppedIdx).toBeGreaterThan(stoppingIdx);
    expect(processStates[processStates.length - 1]).toBe("stopped");
  });

  test("stopDevLoop sets error when stop endpoint returns non-OK", async () => {
    globalThis.fetch = makeFetchStub({ slots: [] }, { stopOk: false });

    const ctrl = new OrchestratorController();
    const states: ReturnType<typeof ctrl.getState>[] = [];
    ctrl.subscribe((s) => states.push(s));

    await ctrl.stopDevLoop();

    const last = states[states.length - 1];
    expect(last.error).toBeTruthy();
  });

  test("poll response with process 'running' updates processState to 'running'", async () => {
    globalThis.fetch = makeFetchStub(
      { slots: [] },
      { statusBody: { process: "running", pid: 42, apiReachable: true, uptimeMs: 500 } },
    );

    const ctrl = new OrchestratorController();
    const states: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => states.push(s));
    ctrl.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctrl.stop();
    unsub();

    const last = states[states.length - 1];
    expect(last.processState).toBe("running");
    expect(last.apiReachable).toBe(true);
  });

  test("poll response with process 'stopped' updates processState to 'stopped'", async () => {
    globalThis.fetch = makeFetchStub(
      { slots: [] },
      { statusBody: { process: "stopped", pid: null, apiReachable: true, uptimeMs: 0 } },
    );

    const ctrl = new OrchestratorController();
    const states: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => states.push(s));
    ctrl.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctrl.stop();
    unsub();

    const last = states[states.length - 1];
    expect(last.processState).toBe("stopped");
  });

  test("loops payload with plan/dev/doc entries populates loopStatus correctly", async () => {
    const loopsPayload = {
      loops: {
        plan: {
          lastTickAt: 1000,
          lastTickDurationMs: 200,
          circuitTripped: false,
          consecutiveFailures: 0,
        },
        dev: {
          lastTickAt: 2000,
          lastTickDurationMs: 300,
          circuitTripped: true,
          consecutiveFailures: 3,
        },
        doc: {
          lastTickAt: 3000,
          lastTickDurationMs: 150,
          circuitTripped: false,
          consecutiveFailures: 0,
        },
      },
    };

    globalThis.fetch = makeFetchStub({ slots: [] }, { loopsBody: loopsPayload });

    const ctrl = new OrchestratorController();
    const states: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => states.push(s));
    ctrl.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctrl.stop();
    unsub();

    const last = states[states.length - 1];
    expect(last.loops.plan.lastTickAt).toBe(1000);
    expect(last.loops.plan.lastTickDurationMs).toBe(200);
    expect(last.loops.dev.circuitTripped).toBe(true);
    expect(last.loops.dev.consecutiveFailures).toBe(3);
    expect(last.loops.dev.lastTickAt).toBe(2000);
    expect(last.loops.doc.lastTickAt).toBe(3000);
    expect(last.loops.doc.lastTickDurationMs).toBe(150);
  });

  test("non-OK poll response sets apiReachable false and preserves last processState", async () => {
    // First poll returns running, second returns non-OK.
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("status")) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                process: "running",
                pid: 1,
                apiReachable: true,
                uptimeMs: 0,
              }),
          } as Response);
        }
        // Second call: non-OK
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ loops: {} }),
      } as Response);
    });

    const ctrl = new OrchestratorController();
    const states: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => states.push(s));

    ctrl.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Trigger a second poll manually.
    await (ctrl as unknown as { poll: () => Promise<void> }).poll();
    ctrl.stop();
    unsub();

    // After non-OK poll, apiReachable is false and processState is preserved from last good poll.
    const last = states[states.length - 1];
    expect(last.apiReachable).toBe(false);
    expect(last.processState).toBe("running");
  });

  test("subscribe listener is notified on each state change from polling", async () => {
    globalThis.fetch = makeFetchStub({ slots: [] });

    const ctrl = new OrchestratorController();
    const notificationCount = { value: 0 };
    const unsub = ctrl.subscribe(() => {
      notificationCount.value++;
    });

    // Initial subscribe call triggers one notification immediately.
    expect(notificationCount.value).toBe(1);

    ctrl.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctrl.stop();
    unsub();

    // Should have received at least 2 notifications (initial + at least one poll).
    expect(notificationCount.value).toBeGreaterThanOrEqual(2);
  });
});
