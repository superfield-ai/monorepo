/**
 * Tests for prune timing in runDevLoop's slot-worker model.
 *
 * Issue #106: prune stale sessions on wall-clock interval so that pruning
 * fires even during long busy streaks.
 *
 * Strategy: run runDevLoop with one slot. The mock spawn succeeds on the
 * first call then signals abort so the loop exits cleanly after exactly one
 * slot completion. We then check whether the post-slot prune fired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runDevLoop } from "../../loops/dev-loop.ts";
import { WorktreeManager } from "@superfield/git";
import type { AgentResult } from "../../agent.ts";

let tmpRoot: string;
let worktrees: WorktreeManager;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "superfield-prune-test-"));
  worktrees = new WorktreeManager({ root: tmpRoot });
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const ISSUE_NUMBER = 1;
const ISSUE_SLUG = "feat-do-thing";

const PLAN_BODY = `## Phase: Alpha

Goal: Do the thing.
Depends on phases: None.
Scout gate: None.

- #${ISSUE_NUMBER} — feat: do thing [risk: 1]
  <!-- superfield: {"number":${ISSUE_NUMBER},"title":"feat: do thing","phase":"Alpha","kind":"feature","risk":1,"dependencies":[],"parallel_safe":false} -->
`;

function makeClient() {
  const planIssue = {
    number: 61,
    state: "open",
    title: "Plan",
    body: PLAN_BODY,
    html_url: "",
    labels: ["plan"],
  };
  const workIssue = {
    number: ISSUE_NUMBER,
    state: "open",
    title: "feat: do thing",
    body: "## Phase\nAlpha\n\n## Motivation\nbecause\n\n## Features\n- [ ] x\n\n## Test Plan\n- [ ] y",
    html_url: "https://github.com/org/repo/issues/1",
    labels: [],
  };
  return {
    listIssues: vi.fn().mockResolvedValue([planIssue]),
    getIssue: vi
      .fn()
      .mockImplementation(async (_o: string, _r: string, n: number) =>
        n === 61 ? planIssue : workIssue,
      ),
    listIssueComments: vi.fn().mockResolvedValue([]),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const okResult: AgentResult = {
  sessionId: "aaaaaaaa-0000-0000-0000-000000000000",
  output: "",
  isError: true, // isError=true skips self-audit, so only one spawn call needed
  costUsd: 0,
  needsBlueprintEscalation: false,
};

/**
 * Runs runDevLoop with one slot. The spawn mock succeeds once then aborts
 * the loop, so exactly one slot completion is observed before exit.
 */
async function runOneSlot(opts: {
  pruneIntervalMs: number;
  pruneFn: ReturnType<typeof vi.fn>;
}): Promise<void> {
  const controller = new AbortController();

  const spawn = vi.fn().mockImplementation(async (): Promise<AgentResult> => {
    controller.abort();
    return okResult;
  });

  // Pre-create the worktree dir so WorktreeManager.create doesn't clone
  const dir = worktrees.worktreePath("org", "repo", ISSUE_NUMBER, ISSUE_SLUG);
  await fs.mkdir(dir, { recursive: true });

  await runDevLoop({
    client: makeClient(),
    owner: "org",
    repo: "repo",
    token: "tok",
    slotCount: 1,
    idlePollMs: 0,
    pruneIntervalMs: opts.pruneIntervalMs,
    _pruneFn: opts.pruneFn,
    _abortSignal: controller.signal,
    worktrees,
    spawn,
  });
}

describe("runDevLoop prune interval (slot-worker model)", () => {
  it("fires prune after completing a slot when interval has elapsed", async () => {
    const pruneFn = vi
      .fn()
      .mockResolvedValue({ prunedWorktrees: [], reapedSessions: [] });

    await runOneSlot({ pruneIntervalMs: 0, pruneFn });

    // startup prune + post-slot prune (interval=0 so always fires)
    expect(pruneFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fire post-slot prune before interval elapses", async () => {
    const pruneFn = vi
      .fn()
      .mockResolvedValue({ prunedWorktrees: [], reapedSessions: [] });

    await runOneSlot({ pruneIntervalMs: 60_000, pruneFn });

    // Only the startup prune; post-slot interval check is skipped
    expect(pruneFn).toHaveBeenCalledTimes(1);
  });
});
