/**
 * @file worktree-manager.ts
 *
 * Git worktree operations for studio sessions.
 *
 * Each studio session gets its own git worktree forked from the current
 * main HEAD. This isolates session work from the product repo's main
 * branch — users can explore changes without affecting main.
 *
 * Worktrees are created in a configurable base directory (default:
 * <sourceDir>/../studio-worktrees/) with each worktree living in a
 * subdirectory named after the session branch.
 *
 * @see docs/studio-sessions.md
 */

import { existsSync } from "fs";
import { join, resolve } from "path";
import { spawn } from "./spawn";
import { buildStudioBranchName, generateSessionId } from "./studio-session";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorktreeCreateOptions {
  /** Absolute path to the product source (main repo). */
  sourceDir: string;

  /** Base directory for worktrees. Default: <sourceDir>/../studio-worktrees */
  worktreeBaseDir?: string;

  /** The main branch hash to fork from. */
  mainHash: string;

  /** Session ID. If omitted, one will be generated. */
  sessionId?: string;
}

export interface WorktreeCreateResult {
  /** The session ID used. */
  sessionId: string;

  /** The branch name created (studio/session-<mainHash>-<sessionId>). */
  branch: string;

  /** Absolute path to the created worktree directory. */
  worktreePath: string;
}

export interface WorktreeDeleteOptions {
  /** Absolute path to the product source (main repo). */
  sourceDir: string;

  /** Absolute path to the worktree to remove. */
  worktreePath: string;

  /** Branch name to delete after removing the worktree. */
  branch: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the base directory where worktrees are stored.
 */
export function resolveWorktreeBaseDir(
  sourceDir: string,
  override?: string,
): string {
  if (override) return resolve(override);
  return resolve(sourceDir, "..", "studio-worktrees");
}

/**
 * Get the current main branch HEAD hash.
 */
export function getMainHash(sourceDir: string): string {
  const result = spawn("git", ["rev-parse", "HEAD"], { cwd: sourceDir });
  if (result.status !== 0) {
    throw new Error(`Failed to get main HEAD: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// ── Create worktree ──────────────────────────────────────────────────────────

/**
 * Create a new git worktree from main HEAD on a studio session branch.
 *
 * Steps:
 *   1. Generate or use the provided session ID.
 *   2. Build the branch name: studio/session-<mainHash>-<sessionId>
 *   3. Create the worktree at <worktreeBaseDir>/<branch-safe-name>/
 *   4. Verify the worktree exists on disk.
 *
 * @returns The session ID, branch name, and worktree path.
 * @throws If git worktree add fails.
 */
export function createWorktree(
  opts: WorktreeCreateOptions,
): WorktreeCreateResult {
  const sessionId = opts.sessionId ?? generateSessionId();
  const branch = buildStudioBranchName(opts.mainHash, sessionId);
  const baseDir = resolveWorktreeBaseDir(opts.sourceDir, opts.worktreeBaseDir);

  // Use branch name with slashes replaced as directory name.
  const safeDirName = branch.replace(/\//g, "-");
  const worktreePath = join(baseDir, safeDirName);

  // Create worktree with a new branch from the given commit.
  const result = spawn(
    "git",
    ["worktree", "add", "-b", branch, worktreePath, opts.mainHash],
    { cwd: opts.sourceDir },
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to create worktree: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return { sessionId, branch, worktreePath };
}

// ── Delete worktree ──────────────────────────────────────────────────────────

/**
 * Remove a git worktree and its associated branch.
 *
 * Steps:
 *   1. Run `git worktree remove --force <path>` to remove the worktree.
 *   2. Run `git branch -D <branch>` to delete the local branch.
 *   3. Verify the worktree directory no longer exists on disk.
 *
 * @throws If git worktree remove fails.
 */
export function deleteWorktree(opts: WorktreeDeleteOptions): void {
  // Remove the worktree (--force handles uncommitted changes).
  const removeResult = spawn(
    "git",
    ["worktree", "remove", "--force", opts.worktreePath],
    { cwd: opts.sourceDir },
  );

  if (removeResult.status !== 0) {
    throw new Error(
      `Failed to remove worktree: ${removeResult.stderr.trim() || removeResult.stdout.trim()}`,
    );
  }

  // Delete the branch.
  const branchResult = spawn("git", ["branch", "-D", opts.branch], {
    cwd: opts.sourceDir,
  });

  if (branchResult.status !== 0) {
    // Non-fatal: the worktree is gone, branch cleanup is best-effort.
    console.warn(
      `Warning: failed to delete branch ${opts.branch}: ${branchResult.stderr.trim()}`,
    );
  }
}

// ── List worktrees ───────────────────────────────────────────────────────────

/**
 * List all git worktrees for the given source directory.
 *
 * @returns Array of { path, branch } for each worktree.
 */
export function listWorktrees(
  sourceDir: string,
): Array<{ path: string; branch: string }> {
  const result = spawn("git", ["worktree", "list", "--porcelain"], {
    cwd: sourceDir,
  });

  if (result.status !== 0) return [];

  const entries: Array<{ path: string; branch: string }> = [];
  let currentPath = "";

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/") && currentPath) {
      entries.push({
        path: currentPath,
        branch: line.slice("branch refs/heads/".length),
      });
      currentPath = "";
    }
  }

  return entries;
}

/**
 * Check whether a worktree directory exists on disk.
 */
export function worktreeExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}
