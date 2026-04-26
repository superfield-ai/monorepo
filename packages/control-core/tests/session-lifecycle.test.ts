/**
 * @file packages/core/tests/session-lifecycle.test.ts
 *
 * Unit tests for session-lifecycle module — verifies that the restart
 * sequence calls teardown before worktree delete, then create before
 * cluster start.
 *
 * Issue #28 test plan items:
 *   - Unit: restart sequence calls teardown before worktree delete,
 *     then create before cluster start
 *
 * @see packages/core/session-lifecycle.ts
 * @see docs/studio-sessions.md
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Track call order to verify sequencing.
const callOrder: string[] = [];

const mockGetMainHash = vi.fn<(sourceDir: string) => string>(() => "abc123");
const mockCreateWorktree = vi.fn<
  (opts: object) => { sessionId: string; branch: string; worktreePath: string }
>(() => ({
  sessionId: "a1b2",
  branch: "studio/session-abc123-a1b2",
  worktreePath: "/tmp/wt/studio-session-abc123-a1b2",
}));
const mockDeleteWorktree = vi.fn<(opts: object) => void>();
const mockWorktreeExists = vi.fn<(path: string) => boolean>(() => false);

vi.mock("../worktree-manager", () => ({
  getMainHash: (sourceDir: string) => {
    callOrder.push("getMainHash");
    return mockGetMainHash(sourceDir);
  },
  createWorktree: (opts: object) => {
    callOrder.push("createWorktree");
    return mockCreateWorktree(opts);
  },
  deleteWorktree: (opts: object) => {
    callOrder.push("deleteWorktree");
    return mockDeleteWorktree(opts);
  },
  worktreeExists: (path: string) => mockWorktreeExists(path),
}));

import {
  startSession,
  restartSession,
  teardownSession,
  isSessionCleanedUp,
} from "../session-lifecycle";
import type { SessionState, SessionStartOptions } from "../session-lifecycle";
import type { StudioClusterConfig } from "../types";

describe("session-lifecycle", () => {
  const clusterConfig: StudioClusterConfig = {
    sourceDir: "/product",
    k8sDir: "k8s",
    namespace: "default",
    verbose: false,
  };

  let startCluster: ReturnType<typeof vi.fn>;
  let teardownCluster: ReturnType<typeof vi.fn>;
  let opts: SessionStartOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;

    startCluster = vi.fn(async () => {
      callOrder.push("startCluster");
    });
    teardownCluster = vi.fn(async () => {
      callOrder.push("teardownCluster");
    });

    opts = {
      sourceDir: "/product",
      worktreeBaseDir: "/tmp/wt",
      clusterConfig,
      startCluster,
      teardownCluster,
    };
  });

  describe("startSession", () => {
    it("creates worktree then starts cluster", async () => {
      const session = await startSession(opts);

      expect(session.sessionId).toBe("a1b2");
      expect(session.branch).toBe("studio/session-abc123-a1b2");
      expect(session.worktreePath).toBe("/tmp/wt/studio-session-abc123-a1b2");
      expect(session.mainHash).toBe("abc123");

      // Verify call sequence: getMainHash -> createWorktree -> startCluster.
      expect(callOrder).toEqual([
        "getMainHash",
        "createWorktree",
        "startCluster",
      ]);
    });

    it("passes worktree path as sourceDir to cluster config", async () => {
      await startSession(opts);

      expect(startCluster).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceDir: "/tmp/wt/studio-session-abc123-a1b2",
        }),
      );
    });
  });

  describe("restartSession", () => {
    const currentSession: SessionState = {
      sessionId: "old1",
      branch: "studio/session-oldabc-old1",
      worktreePath: "/tmp/wt/studio-session-oldabc-old1",
      mainHash: "oldabc",
    };

    it("calls teardown before worktree delete, then create before cluster start", async () => {
      const newSession = await restartSession(currentSession, opts);

      // Verify strict ordering.
      expect(callOrder).toEqual([
        "teardownCluster",
        "deleteWorktree",
        "getMainHash",
        "createWorktree",
        "startCluster",
      ]);

      // New session should have different state.
      expect(newSession.sessionId).toBe("a1b2");
      expect(newSession.branch).toBe("studio/session-abc123-a1b2");
    });

    it("tears down old cluster with old worktree path", async () => {
      await restartSession(currentSession, opts);

      expect(teardownCluster).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceDir: "/tmp/wt/studio-session-oldabc-old1",
        }),
      );
    });

    it("deletes old worktree", async () => {
      await restartSession(currentSession, opts);

      expect(mockDeleteWorktree).toHaveBeenCalledWith({
        sourceDir: "/product",
        worktreePath: "/tmp/wt/studio-session-oldabc-old1",
        branch: "studio/session-oldabc-old1",
      });
    });

    it("starts new cluster with new worktree path", async () => {
      await restartSession(currentSession, opts);

      expect(startCluster).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceDir: "/tmp/wt/studio-session-abc123-a1b2",
        }),
      );
    });
  });

  describe("teardownSession", () => {
    const currentSession: SessionState = {
      sessionId: "x1y2",
      branch: "studio/session-abc123-x1y2",
      worktreePath: "/tmp/wt/studio-session-abc123-x1y2",
      mainHash: "abc123",
    };

    it("tears down cluster then deletes worktree", async () => {
      await teardownSession(currentSession, opts);

      expect(callOrder).toEqual(["teardownCluster", "deleteWorktree"]);
    });

    it("tears down cluster with session worktree path", async () => {
      await teardownSession(currentSession, opts);

      expect(teardownCluster).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceDir: "/tmp/wt/studio-session-abc123-x1y2",
        }),
      );
    });
  });

  describe("isSessionCleanedUp", () => {
    const session: SessionState = {
      sessionId: "x1y2",
      branch: "studio/session-abc123-x1y2",
      worktreePath: "/tmp/wt/studio-session-abc123-x1y2",
      mainHash: "abc123",
    };

    it("returns true when worktree does not exist", () => {
      mockWorktreeExists.mockReturnValue(false);
      expect(isSessionCleanedUp(session)).toBe(true);
    });

    it("returns false when worktree still exists", () => {
      mockWorktreeExists.mockReturnValue(true);
      expect(isSessionCleanedUp(session)).toBe(false);
    });
  });
});
