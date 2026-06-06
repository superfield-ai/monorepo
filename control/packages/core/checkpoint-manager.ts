/**
 * @file checkpoint-manager.ts
 *
 * Checkpoint commit creation and timeline management for studio sessions.
 *
 * After Claude completes a Design mode edit, studio automatically creates a
 * checkpoint commit on the session branch with a plain-language summary.
 * The timeline is always linear — no branches or forks within a session.
 *
 * ## Checkpoint creation
 *   1. Check for uncommitted changes (staged + unstaged) in the worktree.
 *   2. If no changes exist, skip — no checkpoint is created.
 *   3. Stage all changes with `git add -A`.
 *   4. Create a commit with the provided plain-language summary.
 *
 * ## Timeline
 *   - List all checkpoint commits on the session branch since the fork point.
 *   - Each entry includes the commit hash, summary, and ISO 8601 timestamp.
 *
 * ## Rollback
 *   - Reset the session branch HEAD to a selected commit SHA.
 *   - All commits after the selected one are discarded (hard reset).
 *
 * @see docs/studio-sessions.md
 */

import { spawn } from './spawn';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CheckpointEntry {
  /** Abbreviated commit hash. */
  hash: string;
  /** Plain-language summary of the change. */
  summary: string;
  /** ISO 8601 timestamp of the commit. */
  timestamp: string;
}

export interface CreateCheckpointOptions {
  /** Absolute path to the session worktree. */
  worktreePath: string;
  /** Plain-language summary for the checkpoint commit message. */
  summary: string;
}

export interface CreateCheckpointResult {
  /** Whether a checkpoint was created. False when there were no changes. */
  created: boolean;
  /** The commit hash if a checkpoint was created. */
  hash?: string;
}

export interface TimelineOptions {
  /** Absolute path to the session worktree. */
  worktreePath: string;
  /** Base ref to list commits from (e.g. the fork point hash). */
  baseRef: string;
}

export interface RollbackOptions {
  /** Absolute path to the session worktree. */
  worktreePath: string;
  /** The commit SHA to roll back to. */
  targetHash: string;
}

// ── Checkpoint creation ──────────────────────────────────────────────────────

/**
 * Check whether the worktree has any uncommitted changes (staged or unstaged).
 *
 * Uses `git status --porcelain` which outputs one line per changed file.
 * An empty output means no changes.
 */
export function hasChanges(worktreePath: string): boolean {
  const result = spawn('git', ['status', '--porcelain'], { cwd: worktreePath });
  if (result.status !== 0) {
    throw new Error(`git status failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim().length > 0;
}

/**
 * Create a checkpoint commit on the session branch.
 *
 * Steps:
 *   1. Check for changes — if none, return { created: false }.
 *   2. Stage all changes with `git add -A`.
 *   3. Commit with the provided summary as the message.
 *   4. Return the new commit hash.
 *
 * @returns Result indicating whether a checkpoint was created.
 * @throws If git add or git commit fails.
 */
export function createCheckpoint(opts: CreateCheckpointOptions): CreateCheckpointResult {
  if (!hasChanges(opts.worktreePath)) {
    return { created: false };
  }

  // Stage all changes.
  const addResult = spawn('git', ['add', '-A'], { cwd: opts.worktreePath });
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr.trim()}`);
  }

  // Commit with the plain-language summary.
  const commitResult = spawn(
    'git',
    ['commit', '--no-verify', '-m', opts.summary],
    { cwd: opts.worktreePath },
  );
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr.trim()}`);
  }

  // Get the new commit hash.
  const hashResult = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: opts.worktreePath });
  if (hashResult.status !== 0) {
    throw new Error(`git rev-parse failed: ${hashResult.stderr.trim()}`);
  }

  return {
    created: true,
    hash: hashResult.stdout.trim(),
  };
}

// ── Timeline ─────────────────────────────────────────────────────────────────

/**
 * List all checkpoint commits on the session branch since the base ref.
 *
 * Returns entries in chronological order (oldest first) with hash, summary,
 * and ISO 8601 timestamp.
 *
 * Uses `git log --format=<hash>|<iso-date>|<subject>` for structured output.
 */
export function getTimeline(opts: TimelineOptions): CheckpointEntry[] {
  const result = spawn(
    'git',
    [
      'log',
      `${opts.baseRef}..HEAD`,
      '--format=%h|%aI|%s',
      '--reverse',
    ],
    { cwd: opts.worktreePath },
  );

  if (result.status !== 0) {
    // If the base ref is not found, return empty timeline.
    return [];
  }

  return parseTimelineOutput(result.stdout);
}

/**
 * Parse the structured git log output into CheckpointEntry objects.
 *
 * Format per line: `<hash>|<iso-date>|<subject>`
 * The subject may itself contain pipe characters, so we only split on
 * the first two pipes.
 */
export function parseTimelineOutput(output: string): CheckpointEntry[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const firstPipe = line.indexOf('|');
      const secondPipe = line.indexOf('|', firstPipe + 1);
      if (firstPipe === -1 || secondPipe === -1) {
        return null;
      }
      return {
        hash: line.slice(0, firstPipe),
        timestamp: line.slice(firstPipe + 1, secondPipe),
        summary: line.slice(secondPipe + 1),
      };
    })
    .filter((entry): entry is CheckpointEntry => entry !== null);
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/**
 * Roll the session branch back to the specified commit.
 *
 * Uses `git reset --hard <hash>` to move HEAD and discard all commits
 * after the target. The worktree is updated to match.
 *
 * @throws If the reset fails.
 */
export function rollbackToCheckpoint(opts: RollbackOptions): void {
  const result = spawn(
    'git',
    ['reset', '--hard', opts.targetHash],
    { cwd: opts.worktreePath },
  );
  if (result.status !== 0) {
    throw new Error(`git reset failed: ${result.stderr.trim()}`);
  }
}
