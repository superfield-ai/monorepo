/**
 * @file git.ts
 *
 * Git operations for the Studio Server API.
 *
 * All functions spawn git subprocesses via Bun.spawn in REPO_ROOT
 * (the superfield app directory). They are thin wrappers so the API
 * handlers stay readable and testable.
 *
 * ## Functions
 *
 *   - getCurrentBranch()          — git rev-parse --abbrev-ref HEAD
 *   - getSessionCommits()         — commits between fork point and HEAD
 *   - getTimelineCommits()        — same, with timestamps, oldest-first
 *   - rollbackTo(hash)            — git reset --hard <hash>
 *   - hasUncommittedChanges()     — git status --porcelain
 *   - createCheckpointCommit()    — git add -A && git commit
 */

import { REPO_ROOT } from "./agent";
import { parseSessionCommits, parseTimelineCommits } from "./helpers";
import { readProcStdout } from "../lib/response";

/**
 * Resolve the base ref to compare commits against.
 *
 * Tries main → origin/main → master → origin/master in order.
 * Falls back to HEAD^1 (the merge parent) if no named branch is found.
 * Returns null if nothing resolves (e.g. initial commit with no parent).
 *
 * @param explicitBaseBranch  Optional caller-specified branch name to use instead.
 */
async function resolveCommitBaseRef(
  explicitBaseBranch?: string,
): Promise<string | null> {
  const candidates = explicitBaseBranch
    ? [explicitBaseBranch]
    : ["main", "origin/main", "master", "origin/master"];

  for (const ref of candidates) {
    const proc = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", ref], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await readProcStdout(proc.stdout);
    await proc.exited;
    if (output.trim()) return ref;
  }

  const mergeParentProc = Bun.spawn(
    ["git", "rev-parse", "--verify", "--quiet", "HEAD^1"],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const mergeParent = await readProcStdout(mergeParentProc.stdout);
  await mergeParentProc.exited;
  if (mergeParent.trim()) return "HEAD^1";

  return null;
}

/**
 * Return the name of the current git branch.
 *
 * Runs: git rev-parse --abbrev-ref HEAD
 */
export async function getCurrentBranch(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  const output = await readProcStdout(proc.stdout);
  return output.trim();
}

/**
 * List commits made in this session (since the fork point).
 *
 * Returns an array of `{ hash, message }` objects in reverse-chronological
 * order (newest first), suitable for the session timeline UI.
 *
 * @param baseBranch  Optional explicit base branch. Auto-detected if omitted.
 */
export async function getSessionCommits(
  baseBranch?: string,
): Promise<{ hash: string; message: string }[]> {
  const baseRef = await resolveCommitBaseRef(baseBranch);
  if (!baseRef) return [];

  const proc = Bun.spawn(
    ["git", "log", `${baseRef}..HEAD`, "--oneline", "--no-decorate"],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await readProcStdout(proc.stdout);
  return parseSessionCommits(output);
}

/**
 * List commits made in this session with ISO 8601 timestamps.
 *
 * Returns entries in chronological order (oldest first) — the reverse of
 * getSessionCommits. The format is `%h|%aI|%s` (hash|date|subject).
 *
 * @param baseBranch  Optional explicit base branch. Auto-detected if omitted.
 */
export async function getTimelineCommits(
  baseBranch?: string,
): Promise<{ hash: string; message: string; timestamp: string }[]> {
  const baseRef = await resolveCommitBaseRef(baseBranch);
  if (!baseRef) return [];

  const proc = Bun.spawn(
    ["git", "log", `${baseRef}..HEAD`, "--format=%h|%aI|%s", "--reverse"],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await readProcStdout(proc.stdout);
  return parseTimelineCommits(output);
}

/**
 * Hard-reset the session branch to the given commit hash.
 *
 * Discards all commits after the target, matching the user's chosen
 * checkpoint. The working tree is updated to match.
 *
 * @param hash  The abbreviated or full commit SHA to reset to.
 */
export async function rollbackTo(hash: string): Promise<void> {
  const proc = Bun.spawn(["git", "reset", "--hard", hash], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

/**
 * Check if the worktree has uncommitted changes.
 */
export async function hasUncommittedChanges(): Promise<boolean> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await readProcStdout(proc.stdout);
  return output.trim().length > 0;
}

/**
 * Create a checkpoint commit: stage all changes and commit with the given summary.
 * Returns null if there are no changes to commit.
 */
export async function createCheckpointCommit(
  summary: string,
): Promise<{ hash: string } | null> {
  const changed = await hasUncommittedChanges();
  if (!changed) return null;

  // Stage all changes
  const addProc = Bun.spawn(["git", "add", "-A"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  await addProc.exited;

  // Commit
  const commitProc = Bun.spawn(
    ["git", "commit", "--no-verify", "-m", summary],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await commitProc.exited;

  // Get the hash
  const hashProc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const hashOutput = await readProcStdout(hashProc.stdout);
  return { hash: hashOutput.trim() };
}
