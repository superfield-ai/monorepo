/**
 * Unit tests for OrchestratorController — heartbeat history accumulation.
 *
 * Covers:
 * - buildHeartbeatHistory: running / idle transitions
 * - buildHeartbeatHistory: done entry when slot disappears
 * - heartbeatHistory reflected in getState()
 *
 * Uses stub fetch so no real network calls are made.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { OrchestratorController } from "../../src/controllers/OrchestratorController";

// Minimal fetch stub that resolves empty-ish analytics bodies.
function makeFetchStub(
  slotsPayload: { slots: unknown[] } = { slots: [] },
): typeof fetch {
  return vi.fn().mockImplementation((url: string) => {
    let body: unknown;
    if (String(url).includes("status")) {
      body = { process: "running", pid: 1, apiReachable: true, uptimeMs: 1000 };
    } else if (String(url).includes("loops")) {
      body = { loops: {} };
    } else {
      body = slotsPayload;
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
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
