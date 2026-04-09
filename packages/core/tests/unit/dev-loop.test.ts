import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { tickDevLoop, predecessorsClosed } from "../../loops/dev-loop.ts";
import { WorktreeManager } from "@superfield/git";
import type { GitHubClient, Issue } from "@superfield/github";
import type { AgentOpts, AgentResult } from "../../agent.ts";

let tmpRoot: string;
let worktrees: WorktreeManager;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "superfield-devloop-test-"),
  );
  worktrees = new WorktreeManager({ root: tmpRoot });
  // Pre-create the worktree dir so the test doesn't try to clone over the network
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 10,
    title: "feat: build the thing",
    body: "## Phase\nIdentity\n\n## Motivation\nbecause\n\n## Features\n- [ ] x\n\n## Test Plan\n- [ ] y",
    html_url: "",
    state: "open",
    labels: [],
    ...overrides,
  };
}

const planBodyWithFeature = `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`;

const planBodyWithScoutAndDownstreamFeatures = `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #11 — feat: build the other thing [risk: 4]
  <!-- superfield: {"number":11,"title":"feat: build the other thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`;

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn(),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

/** Spawn calls excluding the pre-PR self-audit (#81) calls. */
function developCallList(spawn: ReturnType<typeof vi.fn>): { 0: AgentOpts }[] {
  return spawn.mock.calls.filter(
    (c: unknown[]) =>
      !(c[0] as AgentOpts).prompt.includes("Pre-PR blueprint self-audit"),
  ) as unknown as { 0: AgentOpts }[];
}
function developCalls(spawn: ReturnType<typeof vi.fn>): number {
  return developCallList(spawn).length;
}

function fakeSpawn(result: Partial<AgentResult> = {}) {
  return vi.fn(async (opts: AgentOpts): Promise<AgentResult> => {
    // Pre-PR self-audit (#81) calls spawn via runLLMTask. Default to a
    // conformant verdict so existing tests don't trip the new stage.
    if (opts.prompt.includes("Pre-PR blueprint self-audit")) {
      return {
        sessionId: "sess-audit",
        output: '{"conformant": true, "violations": []}',
        isError: false,
      };
    }
    return {
      sessionId: "sess-new",
      output: "done",
      isError: false,
      ...result,
    };
  });
}

async function preCreateWorktree(issueNumber: number, slug: string) {
  // Avoid hitting the network: pre-create the worktree directory so
  // WorktreeManager.create returns the existing path immediately.
  const dir = worktrees.worktreePath("o", "r", issueNumber, slug);
  await fs.mkdir(dir, { recursive: true });
}

describe("tickDevLoop", () => {
  it("returns idle when no Plan issue exists", async () => {
    const client = makeClient();
    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn: fakeSpawn(),
    });
    expect(result.idle).toBe(true);
    expect(result.primaryIssue).toBeNull();
    expect(result.mergeGateBlocked).toEqual([]);
    expect(result.reapedSessions).toEqual([]);
  });

  it("selects the top of plan and spawns the agent", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: planBodyWithFeature,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi
        .fn()
        // Dependency check for #10 → #5 closed
        .mockImplementation(async (_o, _r, n: number) => {
          if (n === 5) return makeIssue({ number: 5, state: "closed" });
          if (n === 10) return makeIssue({ number: 10, state: "open" });
          throw new Error(`unexpected getIssue ${n}`);
        }),
    });
    const spawn = fakeSpawn();
    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
    });

    expect(result.primaryIssue).toBe(10);
    expect(result.idle).toBe(false);
    expect(result.mergeGateBlocked).toEqual([]);
    expect(result.reapedSessions).toEqual([]);
    expect(developCalls(spawn)).toBe(1);
  });

  it("passes downstream feature issues into the dev-scout prompt in plan order", async () => {
    await preCreateWorktree(5, "scout-identity");
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: planBodyWithScoutAndDownstreamFeatures,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        return makeIssue({ number: n, state: "open" });
      }),
    });
    const spawn = fakeSpawn();

    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const prompt = spawn.mock.calls[0]![0].prompt;
    const firstFeatureIndex = prompt.indexOf("#10: feat: build the thing");
    const secondFeatureIndex = prompt.indexOf(
      "#11: feat: build the other thing",
    );
    expect(firstFeatureIndex).toBeGreaterThanOrEqual(0);
    expect(secondFeatureIndex).toBeGreaterThanOrEqual(0);
    expect(firstFeatureIndex).toBeLessThan(secondFeatureIndex);
  });

  it("does not select an issue whose dependencies are still open", async () => {
    await preCreateWorktree(5, "scout-identity");
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: planBodyWithFeature,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "open" }); // scout still open
        return makeIssue({ number: n, state: "closed" });
      }),
    });
    const spawn = fakeSpawn();
    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
    });
    // Scout #5 should be picked since its deps are empty
    expect(result.primaryIssue).toBe(5);
  });

  it("reports later open issues as merge-gate blocked after selecting the primary", async () => {
    await preCreateWorktree(10, "build-the-thing");
    await preCreateWorktree(11, "build-the-other-thing");
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #11 — feat: build the other thing [risk: 4]
  <!-- superfield: {"number":11,"title":"feat: build the other thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        return makeIssue({ number: n, state: "open" });
      }),
    });
    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn: fakeSpawn(),
      slotCount: 3,
    });

    expect(result.primaryIssue).toBe(10);
    expect(result.mergeGateBlocked).toEqual([11]);
  });

  it("reports closed when issue closes after agent run", async () => {
    await preCreateWorktree(10, "build-the-thing");
    let issue10Calls = 0;
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: planBodyWithFeature,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        if (n === 10) {
          issue10Calls++;
          // First two calls (eligibility + body fetch): open
          // Third call (post-spawn close check): closed
          return makeIssue({
            number: 10,
            state: issue10Calls >= 3 ? "closed" : "open",
          });
        }
        throw new Error(`unexpected getIssue ${n}`);
      }),
    });
    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn: fakeSpawn(),
    });
    expect(result.closed).toBe(true);
    // Session should have been deleted on close — verify deleteIssueComment was called
    // (only if there was a session comment to delete; in this test there isn't, so noop)
  });

  it("reports merge-gate blocked when a new predecessor appears after the agent run", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const initialPlan = `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`;
    const updatedPlan = `- #999 — fix(repo): test:unit failed on main @ abc1234 [risk: 6]
  <!-- superfield: {"number":999,"title":"fix(repo): test:unit failed on main @ abc1234","phase":"watchdog","kind":"ci-failure","risk":6,"dependencies":[],"parallel_safe":true} -->

## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`;
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValueOnce([
          { number: 99, body: initialPlan, labels: ["plan"], state: "open" },
        ])
        .mockResolvedValueOnce([
          { number: 99, body: updatedPlan, labels: ["plan"], state: "open" },
        ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        if (n === 10) return makeIssue({ number: 10, state: "open" });
        if (n === 999) return makeIssue({ number: 999, state: "open" });
        throw new Error(`unexpected getIssue ${n}`);
      }),
    });

    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn: fakeSpawn(),
    });

    expect(result.primaryIssue).toBe(10);
    expect(result.closed).toBe(false);
    expect(result.mergeGateBlocked).toEqual([999]);
    expect(client.deleteIssueComment).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[o/r] merge gate blocked for #10: waiting on #999",
    );
    warn.mockRestore();
  });

  it("claims slot via session comment before spawning", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: planBodyWithFeature,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        return makeIssue({ number: 10, state: "open" });
      }),
    });
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn: fakeSpawn(),
    });
    // upsertSession calls createIssueComment (no existing session)
    expect(client.createIssueComment).toHaveBeenCalled();
    const body = (client.createIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]![3] as string;
    expect(body).toContain("<!-- superfield-session:");
    expect(body).toContain('"role": "primary"');
  });

  it("runs speculative slot when scout is closed", async () => {
    // Two features in the phase: #10 (primary) and #11 (speculative)
    const planBody = `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #11 — feat: build the other thing [risk: 4]
  <!-- superfield: {"number":11,"title":"feat: build the other thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`;
    await preCreateWorktree(10, "build-the-thing");
    await preCreateWorktree(11, "build-the-other-thing");
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValueOnce([
          { number: 99, body: planBody, labels: ["plan"], state: "open" },
        ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" }); // scout closed
        return makeIssue({ number: n, state: "open" });
      }),
    });
    const spawn = fakeSpawn();
    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 3,
    });

    expect(result.primaryIssue).toBe(10);
    expect(result.speculativeIssues).toEqual([11]);
    expect(developCalls(spawn)).toBe(2);
  });

  it("does not open speculative slots when scout is still open", async () => {
    const planBody = `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[],"parallel_safe":true} -->
- #11 — feat: build the other thing [risk: 4]
  <!-- superfield: {"number":11,"title":"feat: build the other thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[],"parallel_safe":true} -->
`;
    await preCreateWorktree(5, "scout-identity");
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValueOnce([
          { number: 99, body: planBody, labels: ["plan"], state: "open" },
        ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        return makeIssue({ number: n, state: "open" }); // scout still open
      }),
    });
    const spawn = fakeSpawn();
    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 3,
    });

    // Primary should be the scout itself
    expect(result.primaryIssue).toBe(5);
    expect(result.speculativeIssues).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not pair speculative work with a ci-failure primary", async () => {
    const planBody = `- #999 — fix(repo): test:unit failed on main @ abc1234 [risk: 6]
  <!-- superfield: {"number":999,"title":"fix(repo): test:unit failed on main @ abc1234","phase":"watchdog","kind":"ci-failure","risk":6,"dependencies":[],"parallel_safe":true} -->

## Phase: Identity

Goal: g.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`;
    await preCreateWorktree(999, "fix-repo-test-unit-failed-on-main-abc1234");
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValueOnce([
          { number: 99, body: planBody, labels: ["plan"], state: "open" },
        ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        return makeIssue({ number: n, state: "open" });
      }),
    });
    const spawn = fakeSpawn();
    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 3,
    });

    expect(result.primaryIssue).toBe(999);
    expect(result.speculativeIssues).toEqual([]);
    expect(result.mergeGateBlocked).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("caps speculative candidates at slotCount - 1 and never includes the primary issue", async () => {
    const planBody = `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #11 — feat: build the other thing [risk: 4]
  <!-- superfield: {"number":11,"title":"feat: build the other thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #12 — feat: build the third thing [risk: 4]
  <!-- superfield: {"number":12,"title":"feat: build the third thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #13 — feat: build the fourth thing [risk: 4]
  <!-- superfield: {"number":13,"title":"feat: build the fourth thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`;
    await preCreateWorktree(10, "build-the-thing");
    await preCreateWorktree(11, "build-the-other-thing");
    await preCreateWorktree(12, "build-the-third-thing");
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValueOnce([
          { number: 99, body: planBody, labels: ["plan"], state: "open" },
        ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        return makeIssue({ number: n, state: "open" });
      }),
    });
    const spawn = fakeSpawn();

    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 3,
    });

    expect(result.primaryIssue).toBe(10);
    expect(result.speculativeIssues).toEqual([11, 12]);
    expect(result.speculativeIssues).not.toContain(10);
    expect(developCalls(spawn)).toBe(3);
  });

  it("excludes speculative candidates whose dependencies are still open", async () => {
    const planBody = `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #11 — feat: build the other thing [risk: 4]
  <!-- superfield: {"number":11,"title":"feat: build the other thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #12 — feat: build the blocked thing [risk: 4]
  <!-- superfield: {"number":12,"title":"feat: build the blocked thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5,99],"parallel_safe":false} -->
`;
    await preCreateWorktree(10, "build-the-thing");
    await preCreateWorktree(11, "build-the-other-thing");
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValueOnce([
          { number: 99, body: planBody, labels: ["plan"], state: "open" },
        ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        if (n === 99) return makeIssue({ number: 99, state: "open" });
        return makeIssue({ number: n, state: "open" });
      }),
    });
    const spawn = fakeSpawn();

    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 3,
    });

    expect(result.primaryIssue).toBe(10);
    expect(result.speculativeIssues).toEqual([11]);
    expect(result.speculativeIssues).not.toContain(12);
    expect(developCalls(spawn)).toBe(2);
  });

  it("resumes existing session when session comment exists", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const existingSession = {
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      role: "primary" as const,
      slot: 1,
      startedAt: "2026-04-08T01:00:00.000Z",
    };
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: planBodyWithFeature,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        return makeIssue({ number: 10, state: "open" });
      }),
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 999,
          body: `<!-- superfield-session:\n${JSON.stringify(existingSession, null, 2)}\n-->`,
        },
      ]),
    });
    const spawn = fakeSpawn();
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
    });
    expect(developCalls(spawn)).toBe(1);
    const spawnArgs = developCallList(spawn)[0]![0];
    expect(spawnArgs.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("prefers a non-stale in-plan session on startup over fresh selection", async () => {
    await preCreateWorktree(11, "build-the-other-thing");
    const existingSession = {
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      role: "primary" as const,
      slot: 1,
      startedAt: new Date().toISOString(),
    };
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] scout identity [risk: 5]
  <!-- superfield: {"number":5,"title":"scout identity","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
- #11 — feat: build the other thing [risk: 4]
  <!-- superfield: {"number":11,"title":"feat: build the other thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[5],"parallel_safe":false} -->
`,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        if (n === 10) return makeIssue({ number: 10, state: "open" });
        if (n === 11) return makeIssue({ number: 11, state: "open" });
        throw new Error(`unexpected getIssue ${n}`);
      }),
      listIssueComments: vi
        .fn()
        .mockImplementation(async (_o, _r, n: number) => {
          if (n === 11) {
            return [
              {
                id: 999,
                body: `<!-- superfield-session:\n${JSON.stringify(existingSession, null, 2)}\n-->`,
              },
            ];
          }
          return [];
        }),
    });
    const spawn = fakeSpawn();

    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
      startupPrioritizedIssueNumbers: [11],
    });

    expect(result.primaryIssue).toBe(11);
    expect(result.reapedSessions).toEqual([]);
    expect(developCalls(spawn)).toBe(1);
    expect(developCallList(spawn)[0]![0].sessionId).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });

  it("reaps a stale startup session and reports it in reapedSessions", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: planBodyWithFeature,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        if (n === 10) return makeIssue({ number: 10, state: "open" });
        throw new Error(`unexpected getIssue ${n}`);
      }),
    });
    const spawn = fakeSpawn();

    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      startupReapedSessions: [10],
    });

    expect(result.primaryIssue).toBe(10);
    expect(result.reapedSessions).toEqual([10]);
    expect(spawn.mock.calls[0]![0].sessionId).toBeUndefined();
  });

  it("reaps a startup session for an issue that is not in the plan", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValueOnce([
        {
          number: 99,
          body: planBodyWithFeature,
          labels: ["plan"],
          state: "open",
        },
      ]),
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "closed" });
        if (n === 10) return makeIssue({ number: 10, state: "open" });
        throw new Error(`unexpected getIssue ${n}`);
      }),
    });
    const spawn = fakeSpawn();

    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      startupReapedSessions: [20],
    });

    expect(result.primaryIssue).toBe(10);
    expect(result.reapedSessions).toEqual([20]);
    expect(spawn.mock.calls[0]![0].sessionId).toBeUndefined();
  });

  it("predecessorsClosed returns false when an earlier issue is still open", async () => {
    const client = makeClient({
      getIssue: vi.fn().mockImplementation(async (_o, _r, n: number) => {
        if (n === 5) return makeIssue({ number: 5, state: "open" });
        return makeIssue({ number: n, state: "closed" });
      }),
    });
    const plan = {
      ciFailures: [],
      phases: [
        {
          name: "P",
          goal: "",
          dependsOn: [],
          scoutGate: 5,
          issues: [
            {
              number: 5,
              title: "first",
              phase: "P",
              kind: "dev-scout" as const,
              risk: 3,
              dependencies: [],
              parallel_safe: true,
            },
            {
              number: 10,
              title: "second",
              phase: "P",
              kind: "feature" as const,
              risk: 3,
              dependencies: [],
              parallel_safe: true,
            },
          ],
        },
      ],
    };
    await expect(predecessorsClosed(client, "o", "r", plan, 10)).resolves.toBe(
      false,
    );
  });

  it("predecessorsClosed returns true when all earlier issues are closed", async () => {
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(makeIssue({ state: "closed" })),
    });
    const plan = {
      ciFailures: [],
      phases: [
        {
          name: "P",
          goal: "",
          dependsOn: [],
          scoutGate: 5,
          issues: [
            {
              number: 5,
              title: "first",
              phase: "P",
              kind: "dev-scout" as const,
              risk: 3,
              dependencies: [],
              parallel_safe: true,
            },
            {
              number: 10,
              title: "second",
              phase: "P",
              kind: "feature" as const,
              risk: 3,
              dependencies: [],
              parallel_safe: true,
            },
          ],
        },
      ],
    };
    await expect(predecessorsClosed(client, "o", "r", plan, 10)).resolves.toBe(
      true,
    );
  });

  it("predecessorsClosed returns true for the first issue in plan order", async () => {
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(makeIssue({ state: "closed" })),
    });
    const plan = {
      ciFailures: [],
      phases: [
        {
          name: "P",
          goal: "",
          dependsOn: [],
          scoutGate: 5,
          issues: [
            {
              number: 5,
              title: "first",
              phase: "P",
              kind: "dev-scout" as const,
              risk: 3,
              dependencies: [],
              parallel_safe: true,
            },
          ],
        },
      ],
    };
    await expect(predecessorsClosed(client, "o", "r", plan, 5)).resolves.toBe(
      true,
    );
  });
});

describe("tickDevLoop — blueprint escalation latch (#78)", () => {
  const archPlanBody = `## Phase: Arch

Goal: architecture module boundary.
Depends on phases: None.
Scout gate: null

- #200 — refactor: architecture module boundary [risk: 4]
  <!-- superfield: {"number":200,"title":"refactor: architecture module boundary","phase":"Arch","kind":"feature","risk":4,"dependencies":[],"parallel_safe":false} -->
`;

  function archIssue(): Issue {
    return {
      number: 200,
      title: "refactor: architecture module boundary",
      body: "## Phase\nArch\n\n## Motivation\nx\n\n## Features\n- [ ] x\n\n## Test Plan\n- [ ] y",
      html_url: "",
      state: "open",
      labels: ["feature", "arch"],
    };
  }

  function makeArchClient(sessionComments: {
    getComments: () => { id: number; body: string }[];
    onUpsert?: (body: string) => void;
  }) {
    const createIssueComment = vi
      .fn()
      .mockImplementation(async (_o, _r, _n, body: string) => {
        sessionComments.onUpsert?.(body);
        return { id: 1 };
      });
    const updateIssueComment = vi
      .fn()
      .mockImplementation(async (_o, _r, _id, body: string) => {
        sessionComments.onUpsert?.(body);
        return undefined;
      });
    return makeClient({
      listIssues: vi
        .fn()
        .mockImplementation(async (_o, _r, labels?: string[]) => {
          if (labels?.includes("plan")) {
            return [
              {
                number: 99,
                body: archPlanBody,
                labels: ["plan"],
                state: "open",
              },
            ];
          }
          return [];
        }),
      getIssue: vi
        .fn()
        .mockImplementation(async (_o, _r, n: number) =>
          n === 200 ? archIssue() : archIssue(),
        ),
      listIssueComments: vi
        .fn()
        .mockImplementation(async () => sessionComments.getComments()),
      createIssueComment,
      updateIssueComment,
    });
  }

  it("latches escalation on first true and persists for the next tick (#78)", async () => {
    await preCreateWorktree(200, "architecture-module-boundary");
    const comments: { id: number; body: string }[] = [];
    const client = makeArchClient({
      getComments: () => comments,
      onUpsert: (body) => {
        // Keep the latest session comment available for the next tick.
        if (comments.length === 0) {
          comments.push({ id: 1, body });
        } else {
          comments[0]!.body = body;
        }
      },
    });

    let callCount = 0;
    const spawn = vi.fn(async (_opts: AgentOpts): Promise<AgentResult> => {
      const current = callCount++;
      return {
        sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        output: "ok",
        isError: false,
        // Turn 1: agent requests escalation. Turn 2: no flag.
        needsBlueprintEscalation: current === 0,
      };
    });

    // Turn 1
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });
    expect(developCalls(spawn)).toBe(1);
    expect(developCallList(spawn)[0]![0].prompt).not.toContain(
      "expanded context — escalation",
    );
    // Turn 2 — latch should now persist via the session comment.
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });
    expect(developCalls(spawn)).toBe(2);
    expect(developCallList(spawn)[1]![0].prompt).toContain(
      "## Blueprint rules (expanded context — escalation)",
    );
    // And the narrow fragment is still present — additive, not replacing.
    expect(developCallList(spawn)[1]![0].prompt).toContain(
      "## Blueprint rules (narrow context — first pass)",
    );
  });

  it("does not escalate when agent never sets the flag (#78)", async () => {
    await preCreateWorktree(200, "architecture-module-boundary");
    const comments: { id: number; body: string }[] = [];
    const client = makeArchClient({
      getComments: () => comments,
      onUpsert: (body) => {
        if (comments.length === 0) comments.push({ id: 1, body });
        else comments[0]!.body = body;
      },
    });
    const spawn = fakeSpawn({
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });

    for (let i = 0; i < 3; i++) {
      await tickDevLoop({
        client,
        owner: "o",
        repo: "r",
        token: "t",
        worktrees,
        spawn,
        slotCount: 1,
      });
    }
    expect(developCalls(spawn)).toBe(3);
    for (const call of developCallList(spawn)) {
      expect(call[0].prompt).not.toContain("expanded context — escalation");
    }
  });

  it("is idempotent across repeated escalation signals — one-shot latch (#78)", async () => {
    await preCreateWorktree(200, "architecture-module-boundary");
    const comments: { id: number; body: string }[] = [];
    const client = makeArchClient({
      getComments: () => comments,
      onUpsert: (body) => {
        if (comments.length === 0) comments.push({ id: 1, body });
        else comments[0]!.body = body;
      },
    });
    // Agent keeps asking for escalation on every turn.
    const spawn = fakeSpawn({
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      needsBlueprintEscalation: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    for (let i = 0; i < 3; i++) {
      await tickDevLoop({
        client,
        owner: "o",
        repo: "r",
        token: "t",
        worktrees,
        spawn,
        slotCount: 1,
      });
    }

    // Latch-fired log line should appear exactly once.
    const latchLogs = log.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("blueprint escalation latched"),
    );
    expect(latchLogs.length).toBe(1);
    log.mockRestore();
  });
});

describe("tickDevLoop — pre-PR blueprint self-audit (#81)", () => {
  const auditPlanBody = `## Phase: Identity

Goal: Build the auth seams.
Depends on phases: None.
Scout gate: null

- #10 — feat: build the thing [risk: 4]
  <!-- superfield: {"number":10,"title":"feat: build the thing","phase":"Identity","kind":"feature","risk":4,"dependencies":[],"parallel_safe":false} -->
`;

  function makeAuditClient(sessionComments: {
    getComments: () => { id: number; body: string }[];
    onUpsert?: (body: string) => void;
  }) {
    const createIssueComment = vi
      .fn()
      .mockImplementation(async (_o, _r, _n, body: string) => {
        sessionComments.onUpsert?.(body);
        return { id: 1 };
      });
    const updateIssueComment = vi
      .fn()
      .mockImplementation(async (_o, _r, _id, body: string) => {
        sessionComments.onUpsert?.(body);
        return undefined;
      });
    return makeClient({
      listIssues: vi
        .fn()
        .mockImplementation(async (_o, _r, labels?: string[]) => {
          if (labels?.includes("plan")) {
            return [
              {
                number: 99,
                body: auditPlanBody,
                labels: ["plan"],
                state: "open",
              },
            ];
          }
          return [];
        }),
      getIssue: vi
        .fn()
        .mockImplementation(async (_o, _r, n: number) =>
          makeIssue({ number: n, state: "open" }),
        ),
      listIssueComments: vi
        .fn()
        .mockImplementation(async () => sessionComments.getComments()),
      createIssueComment,
      updateIssueComment,
    });
  }

  function auditingSpawn(verdict: {
    conformant: boolean;
    violations: object[];
  }) {
    return vi.fn(async (opts: AgentOpts): Promise<AgentResult> => {
      if (opts.prompt.includes("Pre-PR blueprint self-audit")) {
        return {
          sessionId: "audit-sess",
          output: JSON.stringify(verdict),
          isError: false,
        };
      }
      return {
        sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        output: "develop done",
        isError: false,
      };
    });
  }

  const sampleViolation = {
    rule_id: "ARCH-T-001",
    rule_name: "server-code-in-browser-bundle",
    rule_type: "threat",
    domain: "arch",
    concern: "Sample violation concern.",
  };

  it("first-time self-audit has no previousViolations in the prompt", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const comments: { id: number; body: string }[] = [];
    const client = makeAuditClient({
      getComments: () => comments,
      onUpsert: (body) => {
        if (comments.length === 0) comments.push({ id: 1, body });
        else comments[0]!.body = body;
      },
    });
    const spawn = auditingSpawn({ conformant: true, violations: [] });

    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });

    const auditCall = spawn.mock.calls.find((c) =>
      (c[0] as AgentOpts).prompt.includes("Pre-PR blueprint self-audit"),
    );
    expect(auditCall).toBeDefined();
    expect((auditCall![0] as AgentOpts).prompt).not.toContain(
      "## Pending blueprint remediation",
    );
  });

  it("progresses to PR open path on conformant self-audit", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const comments: { id: number; body: string }[] = [];
    const client = makeAuditClient({
      getComments: () => comments,
      onUpsert: (body) => {
        if (comments.length === 0) comments.push({ id: 1, body });
        else comments[0]!.body = body;
      },
    });
    const spawn = auditingSpawn({ conformant: true, violations: [] });

    const result = await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });

    expect(result.primaryIssue).toBe(10);
    // Conformant audit means no remediation state persisted on the session.
    expect(comments[0]!.body).not.toContain("selfAuditPendingViolations");
    expect(comments[0]!.body).not.toContain("selfAuditRemediationCount");
  });

  it("loops back to develop on a violating self-audit with remediationViolations populated", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const comments: { id: number; body: string }[] = [];
    const client = makeAuditClient({
      getComments: () => comments,
      onUpsert: (body) => {
        if (comments.length === 0) comments.push({ id: 1, body });
        else comments[0]!.body = body;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawn = auditingSpawn({
      conformant: false,
      violations: [sampleViolation],
    });

    // Tick 1: violating audit → persists remediation state.
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });
    expect(comments[0]!.body).toContain("selfAuditPendingViolations");
    expect(comments[0]!.body).toContain("ARCH-T-001");
    expect(comments[0]!.body).toContain('"selfAuditRemediationCount": 1');

    // Tick 2: develop prompt should now contain the remediation section.
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });
    const developCallsList = developCallList(spawn);
    expect(developCallsList.length).toBeGreaterThanOrEqual(2);
    const secondDevelopPrompt = developCallsList[1]![0].prompt;
    expect(secondDevelopPrompt).toContain("## Pending blueprint remediation");
    expect(secondDevelopPrompt).toContain("ARCH-T-001");
    warn.mockRestore();
  });

  it("enforces the remediation cap at 3", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const comments: { id: number; body: string }[] = [];
    const client = makeAuditClient({
      getComments: () => comments,
      onUpsert: (body) => {
        if (comments.length === 0) comments.push({ id: 1, body });
        else comments[0]!.body = body;
      },
    });
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawn = auditingSpawn({
      conformant: false,
      violations: [sampleViolation],
    });

    // Run enough ticks to blow past the cap.
    for (let i = 0; i < 5; i++) {
      await tickDevLoop({
        client,
        owner: "o",
        repo: "r",
        token: "t",
        worktrees,
        spawn,
        slotCount: 1,
      });
    }

    // Develop should have been called at most SELF_AUDIT_REMEDIATION_CAP
    // times — once we hit the cap the slot returns early without spawning.
    expect(developCalls(spawn)).toBeLessThanOrEqual(3);
    // The cap-exceeded error should have been logged.
    const capErrors = errLog.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("remediation cap exceeded"),
    );
    expect(capErrors.length).toBeGreaterThanOrEqual(1);
    errLog.mockRestore();
    warn.mockRestore();
  });

  it("persists the remediation count across a dev-loop restart via the session comment", async () => {
    await preCreateWorktree(10, "build-the-thing");
    const comments: { id: number; body: string }[] = [];
    const client = makeAuditClient({
      getComments: () => comments,
      onUpsert: (body) => {
        if (comments.length === 0) comments.push({ id: 1, body });
        else comments[0]!.body = body;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawn = auditingSpawn({
      conformant: false,
      violations: [sampleViolation],
    });

    // Two ticks before "restart".
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });
    expect(comments[0]!.body).toContain('"selfAuditRemediationCount": 2');

    // Simulate a restart: a fresh tickDevLoop call reads the same session
    // comment and bumps the count to 3 on its next non-conformant audit.
    await tickDevLoop({
      client,
      owner: "o",
      repo: "r",
      token: "t",
      worktrees,
      spawn,
      slotCount: 1,
    });
    expect(comments[0]!.body).toContain('"selfAuditRemediationCount": 3');
    warn.mockRestore();
  });
});
