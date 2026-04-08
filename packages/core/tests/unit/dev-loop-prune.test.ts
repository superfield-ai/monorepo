/**
 * Unit tests for runPrunePass in dev-loop.ts
 *
 * Issue #5: worktree pruning + stale session reaping.
 * Verifies that:
 *   1. Worktrees for closed issues are deleted (uses worktrees.list + getIssue).
 *   2. Session comments older than the stale timeout are deleted.
 *   3. Open issue worktrees and fresh sessions are left untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runPrunePass } from "../../loops/dev-loop.ts";
import { WorktreeManager } from "@superfield/git";
import type { GitHubClient, Issue } from "@superfield/github";

let tmpRoot: string;
let worktrees: WorktreeManager;

beforeEach(async () => {
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

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "feat: example",
    body: null,
    html_url: "",
    state: "open",
    labels: [],
    ...overrides,
  };
}

const SESSION_MARKER = "<!-- superfield-session:";
const SESSION_MARKER_END = "-->";

function makeSessionComment(startedAt: string): string {
  return `${SESSION_MARKER}\n${JSON.stringify({ sessionId: "sess-1", role: "primary", slot: 1, startedAt })}\n${SESSION_MARKER_END}`;
}

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn(),
    listIssueComments: vi.fn().mockResolvedValue([]),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

async function makeWorktreeDir(
  issueNumber: number,
  slug: string,
): Promise<string> {
  const wtPath = worktrees.worktreePath("org", "repo", issueNumber, slug);
  await fs.mkdir(wtPath, { recursive: true });
  return wtPath;
}

describe("runPrunePass — worktree cleanup", () => {
  it("prunes worktrees for closed issues", async () => {
    // Pre-create worktree for issue #10 (closed)
    const wtPath = await makeWorktreeDir(10, "build-the-thing");
    expect(
      await fs
        .stat(wtPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    const client = makeClient({
      getIssue: vi
        .fn()
        .mockResolvedValue(makeIssue({ number: 10, state: "closed" })),
      listIssues: vi.fn().mockResolvedValue([]), // no open issues for session scan
    });

    const result = await runPrunePass({
      client,
      owner: "org",
      repo: "repo",
      token: "tok",
      worktrees,
    });

    expect(result.prunedWorktrees).toContain(10);
    // Directory should be gone
    expect(
      await fs
        .stat(wtPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it("leaves worktrees for open issues intact", async () => {
    const wtPath = await makeWorktreeDir(10, "build-the-thing");

    const client = makeClient({
      getIssue: vi
        .fn()
        .mockResolvedValue(makeIssue({ number: 10, state: "open" })),
      listIssues: vi.fn().mockResolvedValue([]),
    });

    await runPrunePass({
      client,
      owner: "org",
      repo: "repo",
      token: "tok",
      worktrees,
    });

    // Directory should still exist
    expect(
      await fs
        .stat(wtPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  it("returns empty prunedWorktrees when no worktrees exist", async () => {
    const client = makeClient();
    const result = await runPrunePass({
      client,
      owner: "org",
      repo: "repo",
      token: "tok",
      worktrees,
    });
    expect(result.prunedWorktrees).toEqual([]);
  });

  it.todo("ignores worktrees owned by other repositories during prune scans");
});

describe("runPrunePass — stale session reaping", () => {
  it("deletes session comments older than the stale timeout", async () => {
    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago
    const sessionBody = makeSessionComment(staleTime);

    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
      listIssueComments: vi
        .fn()
        .mockResolvedValue([{ id: 99, body: sessionBody }]),
      deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPrunePass({
      client,
      owner: "org",
      repo: "repo",
      token: "tok",
      worktrees,
      staleSessionTimeoutMs: 4 * 60 * 60 * 1000, // 4h
    });

    expect(result.reapedSessions).toContain(10);
    expect(client.deleteIssueComment).toHaveBeenCalledWith("org", "repo", 99);
  });

  it("leaves fresh session comments untouched", async () => {
    const freshTime = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago
    const sessionBody = makeSessionComment(freshTime);

    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
      listIssueComments: vi
        .fn()
        .mockResolvedValue([{ id: 99, body: sessionBody }]),
      deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPrunePass({
      client,
      owner: "org",
      repo: "repo",
      token: "tok",
      worktrees,
      staleSessionTimeoutMs: 4 * 60 * 60 * 1000, // 4h
    });

    expect(result.reapedSessions).not.toContain(10);
    expect(client.deleteIssueComment).not.toHaveBeenCalled();
  });

  it("ignores issues with no session comment", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
      listIssueComments: vi
        .fn()
        .mockResolvedValue([{ id: 99, body: "regular comment" }]),
      deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPrunePass({
      client,
      owner: "org",
      repo: "repo",
      token: "tok",
      worktrees,
    });

    expect(result.reapedSessions).toEqual([]);
    expect(client.deleteIssueComment).not.toHaveBeenCalled();
  });

  it("returns empty arrays when no issues exist", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([]),
    });

    const result = await runPrunePass({
      client,
      owner: "org",
      repo: "repo",
      token: "tok",
      worktrees,
    });

    expect(result.prunedWorktrees).toEqual([]);
    expect(result.reapedSessions).toEqual([]);
  });
});
