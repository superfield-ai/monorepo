/**
 * Component tests for OrchestratorView.
 *
 * All 9 scenarios from issue #297:
 *  1. Process state badge renders STOPPED, RUNNING, STARTING, STOPPING states
 *  2. Start button calls OrchestratorController.startDevLoop() and is disabled while running
 *  3. Stop button calls OrchestratorController.stopDevLoop() and is disabled while stopped
 *  4. Slot card renders per active slot (issue number, role, backend, elapsed)
 *  5. Slot heartbeat history renders with data-testid="slot-heartbeat-history-{key}"
 *  6. Loop table renders plan/dev/doc row states
 *  7. Log pane renders with data-testid="log-pane" when log lines are present
 *  8. CI status feed shows ci-status-feed-empty when no runs; ci-row-{key} per run
 *  9. Escalate button (escalate-btn-{key}) fires the escalate action on a failed check-run row
 *
 * Uses a stub OrchestratorController via _replaceState — no real fetch calls.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  OrchestratorView,
  CiStatusFeed,
} from "../../src/components/OrchestratorView";
import {
  OrchestratorController,
  type OrchestratorState,
  type ProcessState,
} from "../../src/controllers/OrchestratorController";
import type { CheckRun } from "../../src/lib/check-runs";

// CiRow mirrors the internal interface in OrchestratorView.tsx.
interface CiRow {
  readonly key: string;
  readonly sha: string;
  readonly checkRun: CheckRun;
  readonly ts: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_LOOP = {
  circuitTripped: false,
  consecutiveFailures: 0,
};

function makeDefaultState(
  partial: Partial<OrchestratorState> = {},
): Partial<OrchestratorState> {
  return {
    processState: "stopped",
    pid: null,
    apiReachable: false,
    uptimeMs: 0,
    loops: {
      plan: { ...DEFAULT_LOOP },
      dev: { ...DEFAULT_LOOP },
      doc: { ...DEFAULT_LOOP },
    },
    slots: [],
    heartbeatHistory: {},
    logs: [],
    error: null,
    ...partial,
  };
}

function makeStubController(initial: Partial<OrchestratorState> = {}): {
  controller: OrchestratorController;
  setState: (partial: Partial<OrchestratorState>) => void;
} {
  const ctrl = new OrchestratorController();
  // Prevent the controller from making real network calls.
  vi.spyOn(ctrl, "start").mockImplementation(() => {});
  vi.spyOn(ctrl, "stop").mockImplementation(() => {});
  ctrl._replaceState(makeDefaultState(initial));
  return {
    controller: ctrl,
    setState: (partial) => ctrl._replaceState(partial),
  };
}

beforeEach(() => {
  // Prevent any EventSource construction (used by CiStatusFeed when no override given).
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      addEventListener() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Scenario 1: Process state badge ──────────────────────────────────────────

describe("process state badge", () => {
  const states: ProcessState[] = ["stopped", "running", "starting", "stopping"];

  for (const state of states) {
    test(`badge shows ${state.toUpperCase()}`, async () => {
      const { controller } = makeStubController({ processState: state });
      const screen = render(
        <OrchestratorView controller={controller} manageLifecycle={false} />,
      );
      await expect
        .element(screen.getByTestId("process-state-badge"))
        .toHaveTextContent(state);
    });
  }
});

// ── Scenario 2: Start button ──────────────────────────────────────────────────

describe("start button", () => {
  test("start button is enabled when stopped and a repo is provided", async () => {
    const { controller } = makeStubController({ processState: "stopped" });
    const startSpy = vi
      .spyOn(controller, "startDevLoop")
      .mockResolvedValue(undefined);
    const screen = render(
      <OrchestratorView
        controller={controller}
        repo="/path/to/repo"
        manageLifecycle={false}
      />,
    );
    const btn = screen.getByTestId("start-button");
    await expect.element(btn).toBeEnabled();
    await btn.click();
    expect(startSpy).toHaveBeenCalledWith("/path/to/repo");
  });

  test("start button is disabled while running", async () => {
    const { controller } = makeStubController({ processState: "running" });
    const screen = render(
      <OrchestratorView
        controller={controller}
        repo="/path/to/repo"
        manageLifecycle={false}
      />,
    );
    await expect.element(screen.getByTestId("start-button")).toBeDisabled();
  });

  test("start button is disabled while starting", async () => {
    const { controller } = makeStubController({ processState: "starting" });
    const screen = render(
      <OrchestratorView
        controller={controller}
        repo="/path/to/repo"
        manageLifecycle={false}
      />,
    );
    await expect.element(screen.getByTestId("start-button")).toBeDisabled();
  });
});

// ── Scenario 3: Stop button ───────────────────────────────────────────────────

describe("stop button", () => {
  test("stop button is disabled while stopped", async () => {
    const { controller } = makeStubController({ processState: "stopped" });
    const screen = render(
      <OrchestratorView controller={controller} manageLifecycle={false} />,
    );
    await expect.element(screen.getByTestId("stop-button")).toBeDisabled();
  });

  test("stop button calls stopDevLoop() and is enabled while running", async () => {
    const { controller } = makeStubController({ processState: "running" });
    const stopSpy = vi
      .spyOn(controller, "stopDevLoop")
      .mockResolvedValue(undefined);
    const screen = render(
      <OrchestratorView controller={controller} manageLifecycle={false} />,
    );
    const btn = screen.getByTestId("stop-button");
    await expect.element(btn).toBeEnabled();
    await btn.click();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Scenario 4: Slot card ─────────────────────────────────────────────────────

describe("slot card", () => {
  test("renders per active slot with issue number, role, backend, and elapsed", async () => {
    const { controller } = makeStubController({
      processState: "running",
      slots: [
        {
          slot: 0,
          issueNumber: 301,
          role: "primary",
          sessionId: "",
          backend: "claude",
          model: "opus",
          startedAt: new Date().toISOString(),
          elapsedMs: 12_000,
          heartbeatAt: Date.now(),
        },
      ],
    });
    const screen = render(
      <OrchestratorView controller={controller} manageLifecycle={false} />,
    );
    await expect.element(screen.getByTestId("slot-card-0")).toBeVisible();
    await expect.element(screen.getByText("#301")).toBeVisible();
    await expect.element(screen.getByText("primary")).toBeVisible();
    await expect.element(screen.getByText("claude")).toBeVisible();
    // elapsed — 12000ms = 12.0s
    await expect.element(screen.getByText(/12\.0s/)).toBeVisible();
  });

  test("renders two slot cards when two slots are active", async () => {
    const now = Date.now();
    const { controller } = makeStubController({
      processState: "running",
      slots: [
        {
          slot: 0,
          issueNumber: 100,
          role: "primary",
          sessionId: "",
          backend: "claude",
          model: "sonnet",
          startedAt: new Date().toISOString(),
          elapsedMs: 1_000,
          heartbeatAt: now,
        },
        {
          slot: 1,
          issueNumber: 200,
          role: "speculative",
          sessionId: "",
          backend: "claude",
          model: "haiku",
          startedAt: new Date().toISOString(),
          elapsedMs: 2_000,
          heartbeatAt: now,
        },
      ],
    });
    const screen = render(
      <OrchestratorView controller={controller} manageLifecycle={false} />,
    );
    await expect.element(screen.getByTestId("slot-card-0")).toBeVisible();
    await expect.element(screen.getByTestId("slot-card-1")).toBeVisible();
  });
});

// ── Scenario 5: Slot heartbeat history ───────────────────────────────────────

describe("slot heartbeat history", () => {
  test("heartbeat history renders with correct data-testid when history is present", async () => {
    const now = Date.now();
    const { controller } = makeStubController({
      processState: "running",
      slots: [
        {
          slot: 2,
          issueNumber: 402,
          role: "primary",
          sessionId: "",
          backend: "claude",
          model: "sonnet",
          startedAt: new Date().toISOString(),
          elapsedMs: 5_000,
          heartbeatAt: now,
        },
      ],
      heartbeatHistory: {
        "2": [
          { at: now - 2000, state: "running" },
          { at: now - 1000, state: "idle" },
        ],
      },
    });
    const screen = render(
      <OrchestratorView controller={controller} manageLifecycle={false} />,
    );
    await expect
      .element(screen.getByTestId("slot-heartbeat-history-2"))
      .toBeVisible();
  });
});

// ── Scenario 6: Loop table ────────────────────────────────────────────────────

describe("loop table", () => {
  test("loop table renders plan, dev, and doc rows", async () => {
    const { controller } = makeStubController({
      loops: {
        plan: {
          circuitTripped: false,
          consecutiveFailures: 0,
          lastTickAt: Date.now() - 3000,
          lastTickDurationMs: 500,
        },
        dev: {
          circuitTripped: true,
          consecutiveFailures: 3,
          idleReason: "no issues",
        },
        doc: { circuitTripped: false, consecutiveFailures: 0 },
      },
    });
    const screen = render(
      <OrchestratorView controller={controller} manageLifecycle={false} />,
    );
    const loopTable = screen.getByTestId("loop-table");
    await expect.element(loopTable).toBeVisible();
    // Each loop name appears as a <td> inside the tbody.
    await expect
      .element(loopTable.getByRole("cell", { name: "plan" }))
      .toBeVisible();
    await expect
      .element(loopTable.getByRole("cell", { name: "dev" }))
      .toBeVisible();
    await expect
      .element(loopTable.getByRole("cell", { name: "doc" }))
      .toBeVisible();
    // Tripped circuit badge
    await expect.element(screen.getByText(/tripped \(3\)/)).toBeVisible();
  });
});

// ── Scenario 7: Log pane ──────────────────────────────────────────────────────

describe("log pane", () => {
  test("log-pane is always visible", async () => {
    const { controller } = makeStubController({});
    const screen = render(
      <OrchestratorView controller={controller} manageLifecycle={false} />,
    );
    await expect.element(screen.getByTestId("log-pane")).toBeVisible();
  });

  test("log lines are rendered inside the log pane", async () => {
    const { controller } = makeStubController({
      logs: ["[info] bootstrap complete", "[warn] slow poll"],
    });
    const screen = render(
      <OrchestratorView controller={controller} manageLifecycle={false} />,
    );
    await expect.element(screen.getByTestId("log-pane")).toBeVisible();
    await expect
      .element(screen.getByText("[info] bootstrap complete"))
      .toBeVisible();
    await expect.element(screen.getByText("[warn] slow poll")).toBeVisible();
  });
});

// ── Scenario 8: CI status feed ───────────────────────────────────────────────

describe("CiStatusFeed", () => {
  test("shows ci-status-feed-empty when no runs", async () => {
    const screen = render(
      <CiStatusFeed repo="owner/repo" ciRowsOverride={[]} />,
    );
    await expect
      .element(screen.getByTestId("ci-status-feed-empty"))
      .toBeVisible();
  });

  test("shows ci-row-{key} for each run", async () => {
    const sha = "abc1234";
    const checkRun: CheckRun = {
      name: "build",
      status: "completed",
      conclusion: "success",
    };
    const key = `${sha}:build`;
    const rows: CiRow[] = [{ key, sha, checkRun, ts: Date.now() }];
    const screen = render(
      <CiStatusFeed repo="owner/repo" ciRowsOverride={rows} />,
    );
    await expect.element(screen.getByTestId(`ci-row-${key}`)).toBeVisible();
    await expect.element(screen.getByText("build")).toBeVisible();
  });
});

// ── Scenario 9: Escalate button ───────────────────────────────────────────────

describe("escalate button", () => {
  test("escalate-btn-{key} appears on failed check-run rows and fires escalate action", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const sha = "def5678";
    const checkRun: CheckRun = {
      name: "lint",
      status: "completed",
      conclusion: "failure",
    };
    const key = `${sha}:lint`;
    const rows: CiRow[] = [{ key, sha, checkRun, ts: Date.now() }];

    // Stub fetch so the escalate POST returns a successful response.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              ok: true,
              issueUrl: "https://github.com/owner/repo/issues/42",
            }),
          ),
        json: () =>
          Promise.resolve({
            ok: true,
            issueUrl: "https://github.com/owner/repo/issues/42",
          }),
      }),
    );

    const screen = render(
      <CiStatusFeed repo="owner/repo" ciRowsOverride={rows} />,
    );
    const btn = screen.getByTestId(`escalate-btn-${key}`);
    await expect.element(btn).toBeVisible();
    await btn.click();

    // Wait for the async escalate to complete.
    await new Promise((r) => setTimeout(r, 50));
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/owner/repo/issues/42",
      "_blank",
      "noopener",
    );
  });

  test("escalate button does not appear on successful check-run rows", async () => {
    const sha = "success123";
    const checkRun: CheckRun = {
      name: "tests",
      status: "completed",
      conclusion: "success",
    };
    const key = `${sha}:tests`;
    const rows: CiRow[] = [{ key, sha, checkRun, ts: Date.now() }];
    const screen = render(
      <CiStatusFeed repo="owner/repo" ciRowsOverride={rows} />,
    );
    await expect.element(screen.getByTestId(`ci-row-${key}`)).toBeVisible();
    const btn = screen.container.querySelector(
      `[data-testid="escalate-btn-${key}"]`,
    );
    expect(btn).toBeNull();
  });
});
