import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { tickDevLoop } from "../../loops/dev-loop.ts";
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

function fakeSpawn(result: Partial<AgentResult> = {}) {
  return vi.fn(
    async (_opts: AgentOpts): Promise<AgentResult> => ({
      sessionId: "sess-new",
      output: "done",
      isError: false,
      ...result,
    }),
  );
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
    expect(spawn).toHaveBeenCalledTimes(1);
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
    expect(spawn).toHaveBeenCalledTimes(2);
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
    expect(spawn).toHaveBeenCalledTimes(1);
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
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = spawn.mock.calls[0]![0];
    expect(spawnArgs.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });
});
