/**
 * Unit tests for BlueprintConformanceController.
 *
 * Covers all 9 scenarios from issue #301:
 *  1. Initial state: rules empty, loading false, error null
 *  2. load() sets loading: true, fetches GET /studio/conformance, populates rules and updatedAt
 *  3. load() sets error when fetch returns a non-OK response
 *  4. load() clears a prior error on a successful re-fetch
 *  5. Auto-refresh: start() schedules a timer; after interval fires, load() is called again
 *  6. stop() cancels the auto-refresh timer — no further load() calls after stop()
 *  7. start() with refreshIntervalMs: 0 disables auto-refresh (no timer scheduled)
 *  8. subscribe → listener called immediately with current state; unsubscribe removes it
 *  9. Rule status "pass" / "fail" / "advisory" all survive round-trip through load()
 *
 * Uses fake timers for auto-refresh scenarios and stub fetch — no real network calls.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlueprintConformanceController,
  type ConformanceRule,
} from "../../src/controllers/BlueprintConformanceController";

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetchOk(
  rules: ConformanceRule[],
  updatedAt = "2024-01-01T00:00:00Z",
) {
  return vi.fn(async () => makeJsonResponse({ rules, updatedAt }));
}

function stubFetchError(status = 500) {
  return vi.fn(async () => makeJsonResponse({}, status));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BlueprintConformanceController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Scenario 1: Initial state
  it("has empty rules, loading: false, error: null on construction", () => {
    const ctrl = new BlueprintConformanceController();
    const state = ctrl.getState();
    expect(state.rules).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.updatedAt).toBeNull();
  });

  // Scenario 2: load() populates rules and updatedAt
  it("load() fetches /studio/conformance and populates rules and updatedAt", async () => {
    const rules: ConformanceRule[] = [
      { id: "r1", name: "Rule One", status: "pass" },
    ];
    vi.stubGlobal("fetch", stubFetchOk(rules, "2024-06-01T12:00:00Z"));

    const ctrl = new BlueprintConformanceController({
      conformanceUrl: "/studio/conformance",
    });

    await ctrl.load();

    const state = ctrl.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.rules).toEqual(rules);
    expect(state.updatedAt).toBe("2024-06-01T12:00:00Z");
  });

  // Scenario 3: load() sets error on non-OK response
  it("load() sets error when fetch returns a non-OK response", async () => {
    vi.stubGlobal("fetch", stubFetchError(503));

    const ctrl = new BlueprintConformanceController();
    await ctrl.load();

    const state = ctrl.getState();
    expect(state.loading).toBe(false);
    expect(state.error).not.toBeNull();
    expect(state.rules).toEqual([]);
  });

  // Scenario 4: load() clears a prior error on successful re-fetch
  it("load() clears a prior error on a successful re-fetch", async () => {
    // First call: fail
    vi.stubGlobal("fetch", stubFetchError(500));
    const ctrl = new BlueprintConformanceController();
    await ctrl.load();
    expect(ctrl.getState().error).not.toBeNull();

    // Second call: succeed
    const rules: ConformanceRule[] = [
      { id: "r2", name: "Rule Two", status: "fail" },
    ];
    vi.stubGlobal("fetch", stubFetchOk(rules));
    await ctrl.load();

    expect(ctrl.getState().error).toBeNull();
    expect(ctrl.getState().rules).toEqual(rules);
  });

  // Scenario 5: start() schedules a timer; after interval fires, load() is called again
  it("start() schedules auto-refresh timer that calls load() after interval", async () => {
    vi.useFakeTimers();
    const rules: ConformanceRule[] = [
      { id: "r3", name: "Rule Three", status: "pass" },
    ];
    const fetchMock = vi.fn(async () =>
      makeJsonResponse({ rules, updatedAt: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new BlueprintConformanceController({
      refreshIntervalMs: 5_000,
    });
    ctrl.start();

    // The start() call triggers an immediate load()
    await vi.runAllTilesAsync();
    const callsAfterStart = fetchMock.mock.calls.length;
    expect(callsAfterStart).toBeGreaterThanOrEqual(1);

    // Advance timer by one interval
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterStart);

    ctrl.stop();
  });

  // Scenario 6: stop() cancels the timer — no further load() calls after stop()
  it("stop() cancels the auto-refresh timer so load() is not called again", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      makeJsonResponse({ rules: [], updatedAt: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new BlueprintConformanceController({
      refreshIntervalMs: 5_000,
    });
    ctrl.start();

    // Drain the immediate load
    await vi.runAllTilesAsync();
    const callsBeforeStop = fetchMock.mock.calls.length;

    ctrl.stop();

    // Advance well past the refresh interval — no new calls expected
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock.mock.calls.length).toBe(callsBeforeStop);
  });

  // Scenario 7: start() with refreshIntervalMs: 0 disables auto-refresh
  it("start() with refreshIntervalMs: 0 does not schedule a timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      makeJsonResponse({ rules: [], updatedAt: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new BlueprintConformanceController({ refreshIntervalMs: 0 });
    ctrl.start();

    // Drain immediate load
    await vi.runAllTilesAsync();
    const callsAfterStart = fetchMock.mock.calls.length;

    // Advance time significantly — should not trigger any additional fetch
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock.mock.calls.length).toBe(callsAfterStart);

    ctrl.stop();
  });

  // Scenario 8: subscribe → listener called immediately; unsubscribe removes it
  it("subscribe calls listener immediately with current state; unsubscribe removes it", async () => {
    vi.stubGlobal("fetch", stubFetchOk([]));

    const ctrl = new BlueprintConformanceController();
    const snapshots: ReturnType<typeof ctrl.getState>[] = [];

    const unsub = ctrl.subscribe((s) => snapshots.push(s));
    // Listener should have been called once immediately
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].rules).toEqual([]);

    await ctrl.load();
    // Listener receives loading:true then final state
    expect(snapshots.length).toBeGreaterThan(1);

    const countBefore = snapshots.length;
    unsub();

    // After unsubscribe, load() should not notify this listener
    await ctrl.load();
    expect(snapshots.length).toBe(countBefore);
  });

  // Scenario 9: rule statuses "pass" / "fail" / "advisory" survive round-trip
  it('round-trips rule statuses "pass", "fail", and "advisory" correctly', async () => {
    const rules: ConformanceRule[] = [
      { id: "r-pass", name: "Pass Rule", status: "pass" },
      { id: "r-fail", name: "Fail Rule", status: "fail" },
      { id: "r-advisory", name: "Advisory Rule", status: "advisory" },
    ];
    vi.stubGlobal("fetch", stubFetchOk(rules));

    const ctrl = new BlueprintConformanceController();
    await ctrl.load();

    const state = ctrl.getState();
    expect(state.rules).toHaveLength(3);

    const byId = Object.fromEntries(state.rules.map((r) => [r.id, r]));
    expect(byId["r-pass"].status).toBe("pass");
    expect(byId["r-fail"].status).toBe("fail");
    expect(byId["r-advisory"].status).toBe("advisory");
  });
});
