/**
 * @file packages/core/tests/session-integration.test.ts
 *
 * Integration tests for worktree manager and session lifecycle.
 *
 * These tests create real git repos in temp directories and exercise
 * actual git worktree commands to verify:
 *   - Worktree exists on disk after session start
 *   - Branch matches naming convention
 *   - Old worktree is gone after restart
 *   - New session has different ID after restart
 *   - Concurrent sessions use distinct worktrees
 *   - Main branch ref is unchanged after restart
 *
 * Issue #28 test plan items:
 *   - Integration: start a session, verify worktree exists on disk and
 *     branch matches naming convention
 *   - Integration: restart a session, verify old worktree is gone and
 *     new worktree has different session ID
 *   - Integration: start two sessions concurrently, verify distinct
 *     worktrees and no git lock contention
 *   - Integration: after restart, verify main branch ref is unchanged
 *
 * @see packages/core/worktree-manager.ts
 * @see packages/core/session-lifecycle.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  createWorktree,
  deleteWorktree,
  getMainHash,
  worktreeExists,
  listWorktrees,
} from "../worktree-manager";
import {
  startSession,
  restartSession,
  teardownSession,
  isSessionCleanedUp,
} from "../session-lifecycle";
import type { StudioClusterConfig } from "../types";

/**
 * Create a minimal git repo with one commit in a temp directory.
 */
function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git checkout -b main", { cwd: dir, stdio: "pipe" });
  execSync("touch README.md", { cwd: dir, stdio: "pipe" });
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "initial"', { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("worktree-manager integration", () => {
  let repoDir: string;
  let wtBaseDir: string;

  beforeEach(() => {
    repoDir = createTempRepo();
    wtBaseDir = mkdtempSync(join(tmpdir(), "studio-wt-"));
  });

  afterEach(() => {
    // Clean up worktrees before removing dirs.
    try {
      execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" });
    } catch {
      /* ignore */
    }
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(wtBaseDir, { recursive: true, force: true });
  });

  it("creates a worktree on disk with correct branch name", () => {
    const mainHash = getMainHash(repoDir);
    const result = createWorktree({
      sourceDir: repoDir,
      worktreeBaseDir: wtBaseDir,
      mainHash,
      sessionId: "ab12",
    });

    // Verify branch name.
    expect(result.branch).toBe(`studio/session-${mainHash}-ab12`);
    expect(result.sessionId).toBe("ab12");

    // Verify worktree exists on disk.
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(worktreeExists(result.worktreePath)).toBe(true);

    // Verify git sees the worktree.
    const entries = listWorktrees(repoDir);
    const sessionEntry = entries.find((e) => e.branch === result.branch);
    expect(sessionEntry).toBeDefined();
    expect(sessionEntry!.path).toBe(result.worktreePath);
  });

  it("deletes a worktree and its branch", () => {
    const mainHash = getMainHash(repoDir);
    const created = createWorktree({
      sourceDir: repoDir,
      worktreeBaseDir: wtBaseDir,
      mainHash,
      sessionId: "cd34",
    });

    // Verify it exists first.
    expect(existsSync(created.worktreePath)).toBe(true);

    deleteWorktree({
      sourceDir: repoDir,
      worktreePath: created.worktreePath,
      branch: created.branch,
    });

    // Verify worktree is gone.
    expect(existsSync(created.worktreePath)).toBe(false);

    // Verify branch is gone.
    const branchCheck = execSync("git branch --list " + created.branch, {
      cwd: repoDir,
      encoding: "utf-8",
    });
    expect(branchCheck.trim()).toBe("");
  });

  it("supports two concurrent worktrees without conflict", () => {
    const mainHash = getMainHash(repoDir);

    const wt1 = createWorktree({
      sourceDir: repoDir,
      worktreeBaseDir: wtBaseDir,
      mainHash,
      sessionId: "aa11",
    });

    const wt2 = createWorktree({
      sourceDir: repoDir,
      worktreeBaseDir: wtBaseDir,
      mainHash,
      sessionId: "bb22",
    });

    // Both exist.
    expect(existsSync(wt1.worktreePath)).toBe(true);
    expect(existsSync(wt2.worktreePath)).toBe(true);

    // Distinct paths and branches.
    expect(wt1.worktreePath).not.toBe(wt2.worktreePath);
    expect(wt1.branch).not.toBe(wt2.branch);
    expect(wt1.sessionId).not.toBe(wt2.sessionId);

    // Git sees both.
    const entries = listWorktrees(repoDir);
    expect(entries.find((e) => e.branch === wt1.branch)).toBeDefined();
    expect(entries.find((e) => e.branch === wt2.branch)).toBeDefined();

    // Clean up.
    deleteWorktree({
      sourceDir: repoDir,
      worktreePath: wt1.worktreePath,
      branch: wt1.branch,
    });
    deleteWorktree({
      sourceDir: repoDir,
      worktreePath: wt2.worktreePath,
      branch: wt2.branch,
    });
  });
});

describe("session-lifecycle integration", () => {
  let repoDir: string;
  let wtBaseDir: string;
  const clusterStartCalls: string[] = [];
  const clusterTeardownCalls: string[] = [];

  const clusterConfig: StudioClusterConfig = {
    sourceDir: "", // will be overridden
    k8sDir: "k8s",
    namespace: "default",
    verbose: false,
  };

  beforeEach(() => {
    repoDir = createTempRepo();
    wtBaseDir = mkdtempSync(join(tmpdir(), "studio-wt-"));
    clusterStartCalls.length = 0;
    clusterTeardownCalls.length = 0;
  });

  afterEach(() => {
    try {
      execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" });
    } catch {
      /* ignore */
    }
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(wtBaseDir, { recursive: true, force: true });
  });

  function makeOpts() {
    return {
      sourceDir: repoDir,
      worktreeBaseDir: wtBaseDir,
      clusterConfig,
      startCluster: async (config: StudioClusterConfig) => {
        clusterStartCalls.push(config.sourceDir);
      },
      teardownCluster: async (config: StudioClusterConfig) => {
        clusterTeardownCalls.push(config.sourceDir);
      },
    };
  }

  it("start creates worktree on disk and boots cluster", async () => {
    const session = await startSession(makeOpts());

    // Worktree exists.
    expect(existsSync(session.worktreePath)).toBe(true);

    // Branch matches naming convention.
    expect(session.branch).toMatch(/^studio\/session-[a-f0-9]+-[a-z0-9]{4}$/);

    // Cluster was started with worktree path.
    expect(clusterStartCalls).toHaveLength(1);
    expect(clusterStartCalls[0]).toBe(session.worktreePath);

    // Clean up.
    await teardownSession(session, makeOpts());
  });

  it("restart removes old worktree and creates new one with different ID", async () => {
    const opts = makeOpts();
    const session1 = await startSession(opts);
    const oldPath = session1.worktreePath;
    const oldId = session1.sessionId;

    const session2 = await restartSession(session1, makeOpts());

    // Old worktree is gone.
    expect(existsSync(oldPath)).toBe(false);

    // New worktree exists.
    expect(existsSync(session2.worktreePath)).toBe(true);

    // Different session ID.
    expect(session2.sessionId).not.toBe(oldId);

    // Cluster was torn down then started.
    expect(clusterTeardownCalls).toHaveLength(1);
    expect(clusterStartCalls).toHaveLength(2); // initial start + restart

    // Clean up.
    await teardownSession(session2, makeOpts());
  });

  it("main branch ref is unchanged after restart", async () => {
    const mainHashBefore = getMainHash(repoDir);

    const opts = makeOpts();
    const session1 = await startSession(opts);
    const session2 = await restartSession(session1, makeOpts());

    const mainHashAfter = getMainHash(repoDir);

    // Main has zero new commits.
    expect(mainHashAfter).toBe(mainHashBefore);

    // Clean up.
    await teardownSession(session2, makeOpts());
  });

  it("two concurrent sessions use separate worktrees", async () => {
    const opts1 = makeOpts();
    const opts2 = makeOpts();

    const session1 = await startSession(opts1);
    const session2 = await startSession(opts2);

    // Distinct worktrees.
    expect(session1.worktreePath).not.toBe(session2.worktreePath);
    expect(session1.branch).not.toBe(session2.branch);
    expect(session1.sessionId).not.toBe(session2.sessionId);

    // Both exist.
    expect(existsSync(session1.worktreePath)).toBe(true);
    expect(existsSync(session2.worktreePath)).toBe(true);

    // Clean up.
    await teardownSession(session1, makeOpts());
    await teardownSession(session2, makeOpts());
  });

  it("worktree is fully removed from disk after teardown", async () => {
    const opts = makeOpts();
    const session = await startSession(opts);

    expect(existsSync(session.worktreePath)).toBe(true);

    await teardownSession(session, makeOpts());

    expect(existsSync(session.worktreePath)).toBe(false);
    expect(isSessionCleanedUp(session)).toBe(true);
  });
});
