import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as fs from "node:fs";

export interface RemoteRef {
  ref: string;
  oid: string;
}

export interface GitClientOptions {
  /** Base directory for cloned repositories. Defaults to os.tmpdir()/superfield-repos */
  repoRoot?: string;
}

export class GitClient {
  private repoRoot: string;

  constructor(options: GitClientOptions = {}) {
    this.repoRoot = options.repoRoot ?? "/tmp/superfield-repos";
  }

  private repoDir(owner: string, repo: string): string {
    return `${this.repoRoot}/${owner}/${repo}`;
  }

  async getRemoteHeadSha(
    owner: string,
    repo: string,
    branch: string,
    token: string,
  ): Promise<string> {
    const url = `https://github.com/${owner}/${repo}.git`;
    const refs = await git.listServerRefs({
      http,
      url,
      onAuth: () => ({ username: "x-access-token", password: token }),
      prefix: `refs/heads/${branch}`,
    });
    const ref = refs.find((r) => r.ref === `refs/heads/${branch}`);
    if (!ref) throw new Error(`Branch ${branch} not found in ${owner}/${repo}`);
    return ref.oid;
  }

  async clone(
    owner: string,
    repo: string,
    branch: string,
    token: string,
  ): Promise<string> {
    const dir = this.repoDir(owner, repo);
    await git.clone({
      fs,
      http,
      dir,
      url: `https://github.com/${owner}/${repo}.git`,
      ref: branch,
      singleBranch: true,
      depth: 1,
      onAuth: () => ({ username: "x-access-token", password: token }),
    });
    return dir;
  }

  async resolveRef(owner: string, repo: string, ref: string): Promise<string> {
    const dir = this.repoDir(owner, repo);
    return git.resolveRef({ fs, dir, ref });
  }

  /** Read the GitHub owner/repo from the `origin` remote of a local git directory. */
  async readRemoteOwnerRepo(
    dir: string,
  ): Promise<{ owner: string; repo: string }> {
    const remotes = await git.listRemotes({ fs, dir });
    const origin = remotes.find((r) => r.remote === "origin");
    if (!origin) throw new Error(`No origin remote found in ${dir}`);
    return parseGitHubRemote(origin.url);
  }
}

/** Parse a GitHub remote URL (https or ssh) into owner and repo. */
export function parseGitHubRemote(url: string): {
  owner: string;
  repo: string;
} {
  // https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
  // Also accepts SSH host aliases (e.g. git@github-work:owner/repo.git)
  const match =
    url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/) ??
    url.match(/github\.com\/([^/]+)\/([^/.]+)/) ??
    url.match(/^git@[^:]+:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Cannot parse GitHub remote URL: ${url}`);
  }
  return { owner: match[1], repo: match[2] };
}
