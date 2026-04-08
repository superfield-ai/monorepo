import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Per-issue worktree manager.
 *
 * The PRD requires that each dev-loop slot work in its own dedicated
 * worktree, prepared via isomorphic-git (no `git` binary). Because
 * isomorphic-git has no native worktree support (worktrees as a feature
 * are CLI-specific), we model "worktree" as a fresh shallow clone of the
 * branch into an isolated directory.
 *
 * Layout:
 *   <root>/<owner>__<repo>/issue-<n>-<slug>/
 */
export interface IssueWorktree {
  issueNumber: number;
  branch: string;
  path: string;
}

export interface WorktreeManagerOptions {
  /** Root directory for all worktrees. Defaults to /tmp/superfield-worktrees. */
  root?: string;
}

export class WorktreeManager {
  private root: string;

  constructor(options: WorktreeManagerOptions = {}) {
    this.root = options.root ?? '/tmp/superfield-worktrees';
  }

  /** Returns the directory a worktree would live at, without creating it. */
  worktreePath(owner: string, repo: string, issueNumber: number, slug: string): string {
    const repoDir = `${owner}__${repo}`;
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
    return path.join(this.root, repoDir, `issue-${issueNumber}-${safeSlug}`);
  }

  /** True if a worktree directory exists for the given issue. */
  async exists(owner: string, repo: string, issueNumber: number, slug: string): Promise<boolean> {
    const dir = this.worktreePath(owner, repo, issueNumber, slug);
    try {
      const stat = await fsp.stat(dir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Creates a fresh worktree by shallow-cloning the branch (or main if branch
   * doesn't exist remotely yet) into an isolated directory.
   *
   * If the directory already exists, returns the existing path without
   * recloning. Use `prune` first if you need a clean state.
   */
  async create(opts: {
    owner: string;
    repo: string;
    issueNumber: number;
    slug: string;
    branch: string;
    token: string;
    /** Source branch to base from. Defaults to 'main'. */
    base?: string;
  }): Promise<IssueWorktree> {
    const dir = this.worktreePath(opts.owner, opts.repo, opts.issueNumber, opts.slug);
    if (await this.exists(opts.owner, opts.repo, opts.issueNumber, opts.slug)) {
      return { issueNumber: opts.issueNumber, branch: opts.branch, path: dir };
    }

    await fsp.mkdir(path.dirname(dir), { recursive: true });

    // Try to clone the issue branch directly. If it doesn't exist remotely
    // yet, fall back to base (main) and let the agent create the branch.
    const url = `https://github.com/${opts.owner}/${opts.repo}.git`;
    const base = opts.base ?? 'main';

    let ref = opts.branch;
    try {
      await git.clone({
        fs,
        http,
        dir,
        url,
        ref,
        singleBranch: true,
        depth: 1,
        onAuth: () => ({ username: 'x-access-token', password: opts.token }),
      });
    } catch {
      // Branch doesn't exist remotely yet — clone base and create the branch locally
      ref = base;
      await git.clone({
        fs,
        http,
        dir,
        url,
        ref,
        singleBranch: true,
        depth: 1,
        onAuth: () => ({ username: 'x-access-token', password: opts.token }),
      });
      await git.branch({ fs, dir, ref: opts.branch, checkout: true });
    }

    return { issueNumber: opts.issueNumber, branch: opts.branch, path: dir };
  }

  /** Lists all worktrees managed under root. */
  async list(): Promise<IssueWorktree[]> {
    try {
      await fsp.access(this.root);
    } catch {
      return [];
    }

    const result: IssueWorktree[] = [];
    const repoDirs = await fsp.readdir(this.root);
    for (const repoDir of repoDirs) {
      const fullRepoDir = path.join(this.root, repoDir);
      let entries: string[];
      try {
        entries = await fsp.readdir(fullRepoDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const match = /^issue-(\d+)-(.+)$/.exec(entry);
        if (!match) continue;
        const dir = path.join(fullRepoDir, entry);
        let branch = '';
        try {
          branch = await git.currentBranch({ fs, dir, fullname: false }) ?? '';
        } catch {
          // Not a valid git repo — still count it as a worktree dir
        }
        result.push({
          issueNumber: Number(match[1]!),
          branch,
          path: dir,
        });
      }
    }
    return result;
  }

  /** Deletes a single worktree directory. */
  async prune(owner: string, repo: string, issueNumber: number, slug: string): Promise<boolean> {
    const dir = this.worktreePath(owner, repo, issueNumber, slug);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Deletes all worktrees for issues in the closed list. */
  async pruneClosed(closedIssueNumbers: number[]): Promise<number[]> {
    const closed = new Set(closedIssueNumbers);
    const all = await this.list();
    const pruned: number[] = [];
    for (const wt of all) {
      if (closed.has(wt.issueNumber)) {
        try {
          await fsp.rm(wt.path, { recursive: true, force: true });
          pruned.push(wt.issueNumber);
        } catch {
          // ignore
        }
      }
    }
    return pruned;
  }
}
