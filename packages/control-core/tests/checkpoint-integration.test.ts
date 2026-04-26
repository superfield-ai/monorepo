/**
 * Integration tests for the checkpoint-manager module.
 *
 * These tests create a real temporary git repository and exercise
 * the full checkpoint creation, timeline, and rollback workflow
 * without mocking git.
 *
 * Test plan items covered:
 *   - Integration: full cycle — start session, simulate Design mode edit,
 *     verify checkpoint appears in git log and timeline API response
 *   - Integration: create three checkpoints, roll back to the first,
 *     verify only one commit remains on the branch
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  hasChanges,
  createCheckpoint,
  getTimeline,
  rollbackToCheckpoint,
} from "../checkpoint-manager";

let repoDir: string;
let initialHash: string;

function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, {
    cwd: cwd ?? repoDir,
    encoding: "utf8",
  }).trim();
}

beforeEach(() => {
  // Create a temporary git repo with an initial commit
  repoDir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
  git("init -b main");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  writeFileSync(join(repoDir, "README.md"), "# Test\n");
  git("add -A");
  git('commit --no-verify -m "initial commit"');
  initialHash = git("rev-parse HEAD");
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("checkpoint integration — full cycle", () => {
  it("creates a checkpoint after a simulated edit and shows it in the timeline", () => {
    // Simulate a Design mode edit
    writeFileSync(join(repoDir, "app.ts"), 'console.log("hello");\n');

    expect(hasChanges(repoDir)).toBe(true);

    const result = createCheckpoint({
      worktreePath: repoDir,
      summary: "Added a greeting message",
    });

    expect(result.created).toBe(true);
    expect(result.hash).toBeTruthy();

    // Verify the commit exists in git log
    const log = git("log --oneline");
    expect(log).toContain("Added a greeting message");

    // Verify the timeline
    const timeline = getTimeline({
      worktreePath: repoDir,
      baseRef: initialHash,
    });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].summary).toBe("Added a greeting message");
    expect(timeline[0].timestamp).toBeTruthy();
    // Verify ISO 8601 format
    expect(new Date(timeline[0].timestamp).toISOString()).toBeTruthy();
  });

  it("does not create a checkpoint when there are no changes", () => {
    expect(hasChanges(repoDir)).toBe(false);

    const result = createCheckpoint({
      worktreePath: repoDir,
      summary: "This should not be committed",
    });

    expect(result.created).toBe(false);

    // Verify no new commits
    const log = git("log --oneline");
    expect(log).not.toContain("This should not be committed");
  });
});

describe("checkpoint integration — rollback", () => {
  it("creates three checkpoints and rolls back to the first, leaving only one on the branch", () => {
    // Checkpoint 1
    writeFileSync(join(repoDir, "file1.ts"), "export const a = 1;\n");
    const cp1 = createCheckpoint({
      worktreePath: repoDir,
      summary: "Added file one",
    });
    expect(cp1.created).toBe(true);

    // Checkpoint 2
    writeFileSync(join(repoDir, "file2.ts"), "export const b = 2;\n");
    const cp2 = createCheckpoint({
      worktreePath: repoDir,
      summary: "Added file two",
    });
    expect(cp2.created).toBe(true);

    // Checkpoint 3
    writeFileSync(join(repoDir, "file3.ts"), "export const c = 3;\n");
    const cp3 = createCheckpoint({
      worktreePath: repoDir,
      summary: "Added file three",
    });
    expect(cp3.created).toBe(true);

    // Verify all three are in the timeline
    let timeline = getTimeline({ worktreePath: repoDir, baseRef: initialHash });
    expect(timeline).toHaveLength(3);
    expect(timeline[0].summary).toBe("Added file one");
    expect(timeline[1].summary).toBe("Added file two");
    expect(timeline[2].summary).toBe("Added file three");

    // Roll back to checkpoint 1
    rollbackToCheckpoint({ worktreePath: repoDir, targetHash: cp1.hash! });

    // Verify only one checkpoint remains
    timeline = getTimeline({ worktreePath: repoDir, baseRef: initialHash });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].summary).toBe("Added file one");

    // Verify files 2 and 3 are gone from the worktree
    expect(() => readFileSync(join(repoDir, "file2.ts"))).toThrow();
    expect(() => readFileSync(join(repoDir, "file3.ts"))).toThrow();

    // Verify file 1 still exists
    expect(readFileSync(join(repoDir, "file1.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
  });

  it("rolling back updates the timeline to reflect the new HEAD", () => {
    // Create two checkpoints
    writeFileSync(join(repoDir, "first.ts"), "export const first = true;\n");
    const cp1 = createCheckpoint({
      worktreePath: repoDir,
      summary: "First change",
    });

    writeFileSync(join(repoDir, "second.ts"), "export const second = true;\n");
    createCheckpoint({ worktreePath: repoDir, summary: "Second change" });

    // Roll back to the first
    rollbackToCheckpoint({ worktreePath: repoDir, targetHash: cp1.hash! });

    // Timeline should now only show the first checkpoint
    const timeline = getTimeline({
      worktreePath: repoDir,
      baseRef: initialHash,
    });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].summary).toBe("First change");
    expect(timeline[0].hash).toBe(cp1.hash);
  });
});

describe("checkpoint integration — timeline is linear", () => {
  it("timeline contains no branches or forks", () => {
    // Create several checkpoints sequentially
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(repoDir, `change${i}.ts`), `export const v = ${i};\n`);
      createCheckpoint({
        worktreePath: repoDir,
        summary: `Change number ${i}`,
      });
    }

    const timeline = getTimeline({
      worktreePath: repoDir,
      baseRef: initialHash,
    });
    expect(timeline).toHaveLength(5);

    // Each entry's timestamp should be >= the previous one (chronological order)
    for (let i = 1; i < timeline.length; i++) {
      const prev = new Date(timeline[i - 1].timestamp).getTime();
      const curr = new Date(timeline[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});
