/**
 * @file session-lifecycle.ts
 *
 * Studio session lifecycle orchestration.
 *
 * Wires the session ID and branch-naming primitives from studio-session.ts
 * into actual worktree create/delete and cluster start/teardown operations.
 *
 * ## Session start
 *   1. Get current main HEAD hash.
 *   2. Create a git worktree from main HEAD on a studio session branch.
 *   3. Boot the cluster with the new worktree as the product source.
 *
 * ## Session restart
 *   1. Tear down the running cluster.
 *   2. Delete the old worktree.
 *   3. Get latest main HEAD hash.
 *   4. Create a fresh worktree with a new session ID.
 *   5. Boot the cluster against the new worktree.
 *
 * ## Session teardown
 *   1. Tear down the running cluster.
 *   2. Delete the worktree.
 *
 * @see docs/studio-sessions.md
 */

import type { StudioClusterConfig } from './types';
import {
  createWorktree,
  deleteWorktree,
  getMainHash,
  worktreeExists,
} from './worktree-manager';
import type { WorktreeCreateResult } from './worktree-manager';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionState {
  /** The session ID. */
  sessionId: string;

  /** The studio branch name. */
  branch: string;

  /** Absolute path to the session worktree. */
  worktreePath: string;

  /** The main branch hash this session was forked from. */
  mainHash: string;
}

export interface SessionStartOptions {
  /** Absolute path to the product source (main repo). */
  sourceDir: string;

  /** Base directory for worktrees. Optional override. */
  worktreeBaseDir?: string;

  /** Cluster configuration for starting the cluster. */
  clusterConfig: StudioClusterConfig;

  /**
   * Callback to start the cluster against a worktree.
   * Receives the worktree path as the source directory.
   */
  startCluster: (config: StudioClusterConfig) => Promise<void> | void;

  /**
   * Callback to tear down the running cluster.
   */
  teardownCluster: (config: StudioClusterConfig) => Promise<void> | void;
}

// ── Session start ────────────────────────────────────────────────────────────

/**
 * Start a new studio session.
 *
 * Creates a git worktree from current main HEAD and boots the cluster
 * against it. Returns the session state for tracking.
 *
 * @throws If worktree creation or cluster start fails.
 */
export async function startSession(
  opts: SessionStartOptions,
): Promise<SessionState> {
  const mainHash = getMainHash(opts.sourceDir);

  const worktree: WorktreeCreateResult = createWorktree({
    sourceDir: opts.sourceDir,
    worktreeBaseDir: opts.worktreeBaseDir,
    mainHash,
  });

  // Build cluster config pointing at the worktree.
  const clusterConfig: StudioClusterConfig = {
    ...opts.clusterConfig,
    sourceDir: worktree.worktreePath,
  };

  await opts.startCluster(clusterConfig);

  return {
    sessionId: worktree.sessionId,
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    mainHash,
  };
}

// ── Session restart ──────────────────────────────────────────────────────────

/**
 * Restart a studio session.
 *
 * Tears down the running cluster, deletes the old worktree, creates a
 * fresh worktree from latest main HEAD with a new session ID, and boots
 * the cluster.
 *
 * @param currentSession  The current session state to tear down.
 * @param opts            Options for starting the new session.
 * @returns               New session state.
 * @throws If teardown, worktree operations, or cluster start fails.
 */
export async function restartSession(
  currentSession: SessionState,
  opts: SessionStartOptions,
): Promise<SessionState> {
  // 1. Tear down the running cluster.
  const oldClusterConfig: StudioClusterConfig = {
    ...opts.clusterConfig,
    sourceDir: currentSession.worktreePath,
  };
  await opts.teardownCluster(oldClusterConfig);

  // 2. Delete the old worktree.
  deleteWorktree({
    sourceDir: opts.sourceDir,
    worktreePath: currentSession.worktreePath,
    branch: currentSession.branch,
  });

  // 3. Create a fresh session from latest main HEAD.
  const newMainHash = getMainHash(opts.sourceDir);

  const worktree: WorktreeCreateResult = createWorktree({
    sourceDir: opts.sourceDir,
    worktreeBaseDir: opts.worktreeBaseDir,
    mainHash: newMainHash,
  });

  // 4. Boot the cluster against the new worktree.
  const clusterConfig: StudioClusterConfig = {
    ...opts.clusterConfig,
    sourceDir: worktree.worktreePath,
  };

  await opts.startCluster(clusterConfig);

  return {
    sessionId: worktree.sessionId,
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    mainHash: newMainHash,
  };
}

// ── Session teardown ─────────────────────────────────────────────────────────

/**
 * Tear down a studio session completely.
 *
 * Stops the cluster and removes the worktree from disk.
 *
 * @param currentSession  The session state to tear down.
 * @param opts            Options containing teardown callbacks.
 */
export async function teardownSession(
  currentSession: SessionState,
  opts: Pick<SessionStartOptions, 'sourceDir' | 'clusterConfig' | 'teardownCluster'>,
): Promise<void> {
  // 1. Tear down the cluster.
  const clusterConfig: StudioClusterConfig = {
    ...opts.clusterConfig,
    sourceDir: currentSession.worktreePath,
  };
  await opts.teardownCluster(clusterConfig);

  // 2. Delete the worktree.
  deleteWorktree({
    sourceDir: opts.sourceDir,
    worktreePath: currentSession.worktreePath,
    branch: currentSession.branch,
  });
}

/**
 * Verify that a session's worktree has been fully removed from disk.
 *
 * @returns true if the worktree no longer exists.
 */
export function isSessionCleanedUp(session: SessionState): boolean {
  return !worktreeExists(session.worktreePath);
}
