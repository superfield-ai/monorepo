/**
 * Unit tests for DeployController — rollback, env loading, doctor checks,
 * secrets presence, and CI run state.
 *
 * All network calls are intercepted via stub fetch / EventSource globals —
 * no real HTTP traffic.
 *
 * Scenarios covered (10):
 *  1. Initial state: envs empty, selectedEnv "dev", envsSource "loading"
 *  2. refreshAll() populates envs from GET /studio/deploy/envs
 *  3. refreshAll() falls back gracefully when envs endpoint returns non-OK
 *  4. loadDoctor(env) populates doctorByEnv[env] from GET /studio/deploy/doctor/<env>
 *  5. loadDoctor(env) records an AppError in doctorErrors[env] on failure
 *  6. loadSecrets(env) populates secretsByEnv[env]
 *  7. rollback(env) transitions rolloutActive to true, streams rolloutLog lines, and resolves
 *  8. rollback(env) on "prod" behaves identically — no special gate in the controller
 *  9. selectEnv(env) updates selectedEnv and notifies listeners
 * 10. subscribe → listener called immediately with current state; unsubscribe removes it
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { DeployController } from "../../src/controllers/DeployController";

// ---------------------------------------------------------------------------
// Helpers — fetch stub
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Helpers — EventSource stub
// ---------------------------------------------------------------------------

type ESListener = (ev: MessageEvent) => void;

interface StubES {
  url: string;
  readyState: number;
  listeners: Map<string, Set<ESListener>>;
  closed: boolean;
  addEventListener(type: string, fn: ESListener): void;
  close(): void;
  /** Test helper: dispatch a named event. */
  emit(type: string, data: string): void;
}

let lastES: StubES | null = null;

function createESStub(url: string): StubES {
  const listeners = new Map<string, Set<ESListener>>();
  const stub: StubES = {
    url,
    readyState: 1, // OPEN
    closed: false,
    listeners,
    addEventListener(type: string, fn: ESListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    close() {
      stub.closed = true;
      stub.readyState = 2; // CLOSED
      listeners.clear();
    },
    emit(type: string, data: string) {
      const event = new MessageEvent(type, { data });
      listeners.get(type)?.forEach((h) => h(event));
    },
  };
  lastES = stub;
  return stub;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("DeployController", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    lastES = null;
    globalThis.EventSource = vi.fn(
      (url: string) => createESStub(url),
    ) as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Initial state
  // -------------------------------------------------------------------------

  test("initial state: envs empty, selectedEnv dev, envsSource loading", () => {
    const ctrl = new DeployController();
    const s = ctrl.getState();
    expect(s.envs).toEqual([]);
    expect(s.selectedEnv).toBe("dev");
    expect(s.envsSource).toBe("loading");
    expect(s.rolloutActive).toBe(false);
    expect(s.rolloutLog).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: refreshAll() populates envs
  // -------------------------------------------------------------------------

  test("refreshAll() populates envs from /studio/deploy/envs (github source)", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/studio/deploy/envs")) {
        return Promise.resolve(
          makeJsonResponse({ envs: ["dev", "staging", "prod"], source: "github" }),
        );
      }
      if (String(url).includes("/studio/deploy/doctor/")) {
        return Promise.resolve(
          makeJsonResponse({ env: "dev", checks: [], allOk: true }),
        );
      }
      if (String(url).includes("/studio/deploy/secrets/")) {
        return Promise.resolve(makeJsonResponse({ env: "dev", checks: [] }));
      }
      if (String(url).includes("/studio/deploy/ci")) {
        return Promise.resolve(makeJsonResponse({ runs: [], source: "github" }));
      }
      return Promise.resolve(makeJsonResponse({}, 404));
    });

    const ctrl = new DeployController();
    await ctrl.refreshAll();

    const s = ctrl.getState();
    expect(s.envs).toEqual(["dev", "staging", "prod"]);
    expect(s.envsSource).toBe("github");
    expect(s.envsError).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 3: refreshAll() falls back gracefully on non-OK envs response
  // -------------------------------------------------------------------------

  test("refreshAll() sets envsError when envs endpoint returns non-OK", async () => {
    // Return a fresh Response object per call to avoid "Body already used" errors.
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(makeJsonResponse({ message: "Internal Server Error" }, 500)),
    );

    const ctrl = new DeployController();
    await ctrl.refreshAll();

    const s = ctrl.getState();
    expect(s.envsError).not.toBeNull();
    expect(s.envsError?.code).toBeTruthy();
    // envs should remain empty since loadEnvs failed
    expect(s.envs).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: loadDoctor(env) populates doctorByEnv[env]
  // -------------------------------------------------------------------------

  test("loadDoctor(env) populates doctorByEnv[env] from /studio/deploy/doctor/<env>", async () => {
    const checks = [
      { name: "db-ping", ok: true, detail: "200ms" },
      { name: "redis", ok: false, detail: "connection refused" },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ env: "dev", checks, allOk: false }),
    );

    const ctrl = new DeployController();
    await ctrl.loadDoctor("dev");

    const s = ctrl.getState();
    expect(s.doctorByEnv["dev"]).toEqual(checks);
    expect(s.doctorErrors["dev"]).toBeUndefined();
    expect(s.loadingDoctor.has("dev")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: loadDoctor(env) records AppError on failure
  // -------------------------------------------------------------------------

  test("loadDoctor(env) records AppError in doctorErrors[env] on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ message: "Service Unavailable" }, 503),
    );

    const ctrl = new DeployController();
    await ctrl.loadDoctor("staging");

    const s = ctrl.getState();
    expect(s.doctorErrors["staging"]).toBeDefined();
    expect(s.doctorErrors["staging"].code).toBeTruthy();
    expect(s.doctorByEnv["staging"]).toBeUndefined();
    expect(s.loadingDoctor.has("staging")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 6: loadSecrets(env) populates secretsByEnv[env]
  // -------------------------------------------------------------------------

  test("loadSecrets(env) populates secretsByEnv[env]", async () => {
    const checks = [
      { name: "DATABASE_URL", present: true, detail: "set" },
      { name: "API_KEY", present: false, detail: "missing" },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ env: "dev", checks }),
    );

    const ctrl = new DeployController();
    await ctrl.loadSecrets("dev");

    const s = ctrl.getState();
    expect(s.secretsByEnv["dev"]).toEqual(checks);
    expect(s.loadingSecrets.has("dev")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 7: rollback(env) streams rolloutLog and resolves
  // -------------------------------------------------------------------------

  test("rollback(env) transitions rolloutActive to true, streams rolloutLog lines, and resolves", async () => {
    const jobId = "job-abc-123";
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ jobId }),
    );

    const ctrl = new DeployController();

    // Capture state snapshots to verify rolloutActive goes true before resolving
    const states: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => states.push(s));

    const rollbackPromise = ctrl.rollback("dev");

    // Flush microtasks so the POST completes and EventSource is created
    await new Promise((r) => setTimeout(r, 0));

    // The EventSource should have been created for the rollback log
    expect(lastES).not.toBeNull();
    expect(lastES!.url).toContain("job=");
    expect(lastES!.url).toContain(jobId);

    // Verify rolloutActive is true while streaming
    expect(ctrl.getState().rolloutActive).toBe(true);

    // Emit some log lines via the default message event
    lastES!.emit("message", "Starting rollback...");
    lastES!.emit("message", "Reverting deployment...");

    // Emit done to close the stream and resolve the promise
    lastES!.emit("done", "rollback complete");

    await rollbackPromise;
    unsub();

    const finalState = ctrl.getState();
    expect(finalState.rolloutActive).toBe(false);
    // rolloutLog should accumulate incrementally
    expect(finalState.rolloutLog).toContain("Starting rollback...");
    expect(finalState.rolloutLog).toContain("Reverting deployment...");
    expect(finalState.rolloutLog.some((l) => l.startsWith("done:"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 8: rollback(env) on "prod" behaves identically
  // -------------------------------------------------------------------------

  test("rollback('prod') behaves identically — no gate in the controller", async () => {
    const jobId = "job-prod-999";
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ jobId }),
    );

    const ctrl = new DeployController();
    const rollbackPromise = ctrl.rollback("prod");

    await new Promise((r) => setTimeout(r, 0));

    // Verify the POST was called with the prod env in the URL
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("prod"),
      expect.objectContaining({ method: "POST" }),
    );

    // Emit done to resolve
    expect(lastES).not.toBeNull();
    lastES!.emit("done", "prod rollback complete");

    await rollbackPromise;

    const s = ctrl.getState();
    expect(s.rolloutActive).toBe(false);
    expect(s.rolloutLog.some((l) => l.startsWith("done:"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 9: selectEnv(env) updates selectedEnv and notifies listeners
  // -------------------------------------------------------------------------

  test("selectEnv(env) updates selectedEnv and notifies listeners", async () => {
    // Stub fetch for doctor/secrets called by selectEnv.
    // Return a fresh Response per call to avoid "Body already used" errors.
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(makeJsonResponse({ env: "staging", checks: [], allOk: true })),
    );

    const ctrl = new DeployController();
    const notified: string[] = [];
    const unsub = ctrl.subscribe((s) => notified.push(s.selectedEnv));

    // Initial notification on subscribe
    expect(notified).toEqual(["dev"]);

    ctrl.selectEnv("staging");

    // Should have been notified with new env
    expect(ctrl.getState().selectedEnv).toBe("staging");
    expect(notified).toContain("staging");

    // Calling selectEnv with same env is a no-op (no extra notification)
    const notifiedLengthBefore = notified.length;
    ctrl.selectEnv("staging");
    expect(notified.length).toBe(notifiedLengthBefore);

    unsub();
  });

  // -------------------------------------------------------------------------
  // Scenario 10: subscribe / unsubscribe
  // -------------------------------------------------------------------------

  test("subscribe calls listener immediately with current state; unsubscribe removes it", () => {
    const ctrl = new DeployController();

    const calls: ReturnType<typeof ctrl.getState>[] = [];
    const unsub = ctrl.subscribe((s) => calls.push(s));

    // Listener should have been called once immediately on subscribe
    expect(calls).toHaveLength(1);
    expect(calls[0].selectedEnv).toBe("dev");

    // Trigger a state change
    ctrl._replaceState({ selectedEnv: "prod" });
    expect(calls).toHaveLength(2);
    expect(calls[1].selectedEnv).toBe("prod");

    // Unsubscribe — no more calls after this
    unsub();
    ctrl._replaceState({ selectedEnv: "staging" });
    expect(calls).toHaveLength(2);
  });
});
