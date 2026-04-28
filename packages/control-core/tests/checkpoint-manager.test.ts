/**
 * Unit tests for packages/core/checkpoint-manager.ts
 *
 * Tests the checkpoint creation, timeline parsing, and rollback logic.
 * Git subprocess calls are replaced with vi.mock() doubles — no real
 * filesystem or subprocess involvement.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the spawn module ────────────────────────────────────────────────────

vi.mock("../spawn", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "../spawn";
import {
  hasChanges,
  createCheckpoint,
  getTimeline,
  parseTimelineOutput,
  rollbackToCheckpoint,
} from "../checkpoint-manager";

const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── hasChanges ───────────────────────────────────────────────────────────────

describe("hasChanges", () => {
  it("returns true when git status reports changes", () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: " M src/app.ts\n",
      stderr: "",
    });
    expect(hasChanges("/tmp/worktree")).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith("git", ["status", "--porcelain"], {
      cwd: "/tmp/worktree",
    });
  });

  it("returns false when git status reports no changes", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    expect(hasChanges("/tmp/worktree")).toBe(false);
  });

  it("returns false when git status output is whitespace-only", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: "  \n  ", stderr: "" });
    expect(hasChanges("/tmp/worktree")).toBe(false);
  });

  it("throws when git status fails", () => {
    mockSpawn.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "fatal: not a git repository",
    });
    expect(() => hasChanges("/tmp/worktree")).toThrow("git status failed");
  });
});

// ── createCheckpoint ─────────────────────────────────────────────────────────

describe("createCheckpoint", () => {
  it("creates a checkpoint when there are changes", () => {
    // First call: git status --porcelain (has changes)
    mockSpawn
      .mockReturnValueOnce({ status: 0, stdout: " M file.ts\n", stderr: "" })
      // Second call: git add -A
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      // Third call: git commit
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      // Fourth call: git rev-parse --short HEAD
      .mockReturnValueOnce({ status: 0, stdout: "abc1234\n", stderr: "" });

    const result = createCheckpoint({
      worktreePath: "/tmp/worktree",
      summary: "Updated the login form colors",
    });

    expect(result.created).toBe(true);
    expect(result.hash).toBe("abc1234");

    // Verify commit was called with the summary
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["commit", "--no-verify", "-m", "Updated the login form colors"],
      { cwd: "/tmp/worktree" },
    );
  });

  it("returns created:false when there are no changes", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const result = createCheckpoint({
      worktreePath: "/tmp/worktree",
      summary: "Some change",
    });

    expect(result.created).toBe(false);
    expect(result.hash).toBeUndefined();
    // Only git status should have been called
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("throws when git add fails", () => {
    mockSpawn
      .mockReturnValueOnce({ status: 0, stdout: " M file.ts\n", stderr: "" })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "error: could not add",
      });

    expect(() =>
      createCheckpoint({ worktreePath: "/tmp/worktree", summary: "test" }),
    ).toThrow("git add failed");
  });

  it("throws when git commit fails", () => {
    mockSpawn
      .mockReturnValueOnce({ status: 0, stdout: " M file.ts\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "error: commit failed",
      });

    expect(() =>
      createCheckpoint({ worktreePath: "/tmp/worktree", summary: "test" }),
    ).toThrow("git commit failed");
  });
});

// ── parseTimelineOutput ──────────────────────────────────────────────────────

describe("parseTimelineOutput", () => {
  it("parses structured git log output with timestamps", () => {
    const output = [
      "abc1234|2025-03-15T10:30:00+00:00|Updated the login form",
      "def5678|2025-03-15T10:45:00+00:00|Added a new sidebar",
    ].join("\n");

    const entries = parseTimelineOutput(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      hash: "abc1234",
      timestamp: "2025-03-15T10:30:00+00:00",
      summary: "Updated the login form",
    });
    expect(entries[1]).toEqual({
      hash: "def5678",
      timestamp: "2025-03-15T10:45:00+00:00",
      summary: "Added a new sidebar",
    });
  });

  it("handles summary containing pipe characters", () => {
    const output =
      "abc1234|2025-03-15T10:30:00+00:00|Updated colors | blue to red\n";
    const entries = parseTimelineOutput(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Updated colors | blue to red");
  });

  it("returns empty array for empty output", () => {
    expect(parseTimelineOutput("")).toEqual([]);
  });

  it("returns empty array for whitespace-only output", () => {
    expect(parseTimelineOutput("  \n  \n")).toEqual([]);
  });

  it("skips malformed lines missing pipe separators", () => {
    const output =
      "abc1234 no pipes here\ndef5678|2025-03-15T10:30:00+00:00|Valid entry\n";
    const entries = parseTimelineOutput(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe("def5678");
  });

  it("handles single entry", () => {
    const output = "abc1234|2025-03-15T10:30:00+00:00|First change\n";
    const entries = parseTimelineOutput(output);
    expect(entries).toHaveLength(1);
  });
});

// ── getTimeline ──────────────────────────────────────────────────────────────

describe("getTimeline", () => {
  it("returns timeline entries from git log", () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: "abc1234|2025-03-15T10:30:00+00:00|Updated login form\n",
      stderr: "",
    });

    const entries = getTimeline({
      worktreePath: "/tmp/worktree",
      baseRef: "abc000",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe("abc1234");
    expect(entries[0]!.timestamp).toBe("2025-03-15T10:30:00+00:00");
    expect(entries[0]!.summary).toBe("Updated login form");
  });

  it("returns empty array when git log fails", () => {
    mockSpawn.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "fatal: bad ref",
    });
    const entries = getTimeline({
      worktreePath: "/tmp/worktree",
      baseRef: "badref",
    });
    expect(entries).toEqual([]);
  });

  it("passes --reverse flag to get chronological order", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    getTimeline({ worktreePath: "/tmp/worktree", baseRef: "abc000" });
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["log", "abc000..HEAD", "--format=%h|%aI|%s", "--reverse"],
      { cwd: "/tmp/worktree" },
    );
  });
});

// ── rollbackToCheckpoint ─────────────────────────────────────────────────────

describe("rollbackToCheckpoint", () => {
  it("resets HEAD to the target commit", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    rollbackToCheckpoint({
      worktreePath: "/tmp/worktree",
      targetHash: "abc1234",
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["reset", "--hard", "abc1234"],
      { cwd: "/tmp/worktree" },
    );
  });

  it("throws when git reset fails", () => {
    mockSpawn.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "fatal: bad revision",
    });
    expect(() =>
      rollbackToCheckpoint({
        worktreePath: "/tmp/worktree",
        targetHash: "badref",
      }),
    ).toThrow("git reset failed");
  });
});

// ── Negative path tests ──────────────────────────────────────────────────────

describe("checkpoint-manager — negative paths", () => {
  it("createCheckpoint throws when git rev-parse fails after successful commit", () => {
    mockSpawn
      .mockReturnValueOnce({ status: 0, stdout: " M file.ts\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "fatal: ambiguous",
      });

    expect(() =>
      createCheckpoint({ worktreePath: "/tmp/worktree", summary: "test" }),
    ).toThrow("git rev-parse failed");
  });

  it("parseTimelineOutput handles line with only one pipe", () => {
    const output = "abc1234|incomplete\n";
    const entries = parseTimelineOutput(output);
    expect(entries).toEqual([]);
  });
});
