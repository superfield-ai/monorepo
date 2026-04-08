import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorktreeManager } from "../../worktree.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "superfield-worktree-test-"),
  );
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("WorktreeManager.worktreePath", () => {
  it("builds a deterministic path from owner, repo, issue, slug", () => {
    const wm = new WorktreeManager({ root: "/tmp/test" });
    const p = wm.worktreePath(
      "dot-matrix-labs",
      "superfield-ts",
      42,
      "fix-loop-bug",
    );
    expect(p).toBe(
      "/tmp/test/dot-matrix-labs__superfield-ts/issue-42-fix-loop-bug",
    );
  });

  it("sanitises slugs to lowercase kebab", () => {
    const wm = new WorktreeManager({ root: "/tmp/test" });
    const p = wm.worktreePath("o", "r", 1, "Fix MY Cool/Bug!!");
    expect(p).toBe("/tmp/test/o__r/issue-1-fix-my-cool-bug-");
  });

  it("truncates long slugs", () => {
    const wm = new WorktreeManager({ root: "/tmp/test" });
    const longSlug = "a".repeat(100);
    const p = wm.worktreePath("o", "r", 1, longSlug);
    expect(p.endsWith("a".repeat(40))).toBe(true);
  });
});

describe("WorktreeManager.exists", () => {
  it("returns false when directory does not exist", async () => {
    const wm = new WorktreeManager({ root: tmpRoot });
    expect(await wm.exists("o", "r", 1, "slug")).toBe(false);
  });

  it("returns true when directory exists", async () => {
    const wm = new WorktreeManager({ root: tmpRoot });
    const dir = wm.worktreePath("o", "r", 1, "slug");
    await fs.mkdir(dir, { recursive: true });
    expect(await wm.exists("o", "r", 1, "slug")).toBe(true);
  });
});

describe("WorktreeManager.list", () => {
  it("returns empty array when root does not exist", async () => {
    const wm = new WorktreeManager({ root: path.join(tmpRoot, "nonexistent") });
    expect(await wm.list()).toEqual([]);
  });

  it("lists worktree directories matching the issue-N-slug pattern", async () => {
    const wm = new WorktreeManager({ root: tmpRoot });
    await fs.mkdir(path.join(tmpRoot, "org__repo", "issue-10-foo"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tmpRoot, "org__repo", "issue-20-bar-baz"), {
      recursive: true,
    });
    // Non-conforming directory should be ignored
    await fs.mkdir(path.join(tmpRoot, "org__repo", "random-dir"), {
      recursive: true,
    });

    const list = await wm.list();
    const numbers = list.map((w) => w.issueNumber).sort();
    expect(numbers).toEqual([10, 20]);
  });

  it("lists worktrees for a single repository", async () => {
    const wm = new WorktreeManager({ root: tmpRoot });
    await fs.mkdir(path.join(tmpRoot, "org__repo", "issue-10-foo"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tmpRoot, "org__repo", "issue-20-bar"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tmpRoot, "other__repo", "issue-30-baz"), {
      recursive: true,
    });

    const list = await wm.listForRepository("org", "repo");
    const numbers = list.map((w) => w.issueNumber).sort();

    expect(numbers).toEqual([10, 20]);
  });
});

describe("WorktreeManager.prune", () => {
  it("removes the worktree directory and returns true", async () => {
    const wm = new WorktreeManager({ root: tmpRoot });
    const dir = wm.worktreePath("o", "r", 1, "slug");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "sentinel.txt"), "x");

    const ok = await wm.prune("o", "r", 1, "slug");
    expect(ok).toBe(true);
    expect(await wm.exists("o", "r", 1, "slug")).toBe(false);
  });

  it("returns true even when directory does not exist (idempotent)", async () => {
    const wm = new WorktreeManager({ root: tmpRoot });
    expect(await wm.prune("o", "r", 999, "gone")).toBe(true);
  });
});

describe("WorktreeManager.pruneClosed", () => {
  it("removes only worktrees whose issue numbers are in the closed set", async () => {
    const wm = new WorktreeManager({ root: tmpRoot });
    await fs.mkdir(path.join(tmpRoot, "org__repo", "issue-10-foo"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tmpRoot, "org__repo", "issue-20-bar"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tmpRoot, "org__repo", "issue-30-baz"), {
      recursive: true,
    });

    const pruned = await wm.pruneClosed([10, 30]);
    expect(pruned.sort()).toEqual([10, 30]);

    const remaining = await wm.list();
    expect(remaining.map((w) => w.issueNumber)).toEqual([20]);
  });

  it("returns empty array when no closed issues match", async () => {
    const wm = new WorktreeManager({ root: tmpRoot });
    await fs.mkdir(path.join(tmpRoot, "org__repo", "issue-10-foo"), {
      recursive: true,
    });
    const pruned = await wm.pruneClosed([99]);
    expect(pruned).toEqual([]);
  });
});
