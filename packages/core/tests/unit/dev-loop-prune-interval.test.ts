/**
 * Unit tests for wall-clock prune interval in runDevLoop.
 *
 * Issue #106: prune stale sessions on wall-clock interval so that pruning
 * fires even during long busy streaks (no idle ticks).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DevLoopTickResult } from "../../loops/dev-loop.ts";
import type { SupervisedLoopOpts } from "../../supervised-loop.ts";

import { runDevLoop } from "../../loops/dev-loop.ts";

let capturedRunOnce: (() => Promise<DevLoopTickResult>) | undefined;
const mockPruneFn = vi
  .fn()
  .mockResolvedValue({ prunedWorktrees: [], reapedSessions: [] });
const mockTickFn = vi.fn<() => Promise<DevLoopTickResult>>();
const mockRunSupervisedLoop = vi.fn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (opts: SupervisedLoopOpts<any>) => {
    capturedRunOnce = opts.runOnce;
  },
);

beforeEach(() => {
  vi.clearAllMocks();
  capturedRunOnce = undefined;
});

function makeClient() {
  const planIssue = {
    number: 61,
    state: "open",
    title: "Plan",
    body: "",
    html_url: "",
    labels: ["plan"],
  };
  return {
    listIssues: vi.fn().mockResolvedValue([planIssue]),
    getIssue: vi.fn().mockResolvedValue({
      number: 1,
      state: "open",
      title: "",
      body: null,
      html_url: "",
      labels: [],
    }),
    listIssueComments: vi.fn().mockResolvedValue([]),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function busyResult(): DevLoopTickResult {
  return {
    primaryIssue: 1,
    speculativeIssues: [],
    mergeGateBlocked: [],
    reapedSessions: [],
    closed: false,
    idle: false,
  };
}

function idleResult(): DevLoopTickResult {
  return {
    primaryIssue: null,
    speculativeIssues: [],
    mergeGateBlocked: [],
    reapedSessions: [],
    closed: false,
    idle: true,
    reason: "no eligible primary",
  };
}

async function initLoop(
  pruneIntervalMs: number | undefined,
  tickResult: DevLoopTickResult,
) {
  mockTickFn.mockResolvedValue(tickResult);

  await runDevLoop({
    client: makeClient(),
    owner: "org",
    repo: "repo",
    token: "tok",
    pruneIntervalMs,
    _pruneFn: mockPruneFn,
    _tickFn: mockTickFn,
    _runSupervisedLoop: mockRunSupervisedLoop,
  });
  // Clear the startup prune call
  mockPruneFn.mockClear();
  return capturedRunOnce!;
}

describe("runDevLoop wall-clock prune interval (#106)", () => {
  it("fires prune after interval elapses on busy ticks", async () => {
    const runOnce = await initLoop(0, busyResult());
    await runOnce();
    expect(mockPruneFn).toHaveBeenCalledTimes(1);
  });

  it("does not fire prune on busy tick before interval elapses", async () => {
    const runOnce = await initLoop(60_000, busyResult());
    await runOnce();
    expect(mockPruneFn).not.toHaveBeenCalled();
  });

  it("idle tick still fires prune immediately (existing behaviour)", async () => {
    const runOnce = await initLoop(60_000, idleResult());
    await runOnce();
    expect(mockPruneFn).toHaveBeenCalledTimes(1);
  });

  it("injectable pruneIntervalMs: 0 triggers on every busy tick", async () => {
    const runOnce = await initLoop(0, busyResult());
    await runOnce();
    await runOnce();
    await runOnce();
    expect(mockPruneFn).toHaveBeenCalledTimes(3);
  });
});
