import { Octokit } from "@octokit/rest";

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  base_ref: string;
  head_ref: string;
  head_sha: string;
}

export interface CreateIssueParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}

export interface UpdateIssueParams {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}

/**
 * Structural interface for GitHub API operations used by the Superfield core.
 * Allows injecting test doubles without casting through `unknown`.
 *
 * The concrete `GitHubClient` class satisfies this interface automatically
 * because TypeScript uses structural typing.
 */
export interface GitHubClientPort {
  getHeadSha(owner: string, repo: string, branch?: string): Promise<string>;
  getCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]>;
  getIssue(owner: string, repo: string, issue_number: number): Promise<Issue>;
  listIssues(owner: string, repo: string, labels?: string[]): Promise<Issue[]>;
  createIssue(params: CreateIssueParams): Promise<Issue>;
  updateIssueBody(params: UpdateIssueParams): Promise<void>;
  listIssueComments(
    owner: string,
    repo: string,
    issue_number: number,
  ): Promise<{ id: number; body: string }[]>;
  createIssueComment(
    owner: string,
    repo: string,
    issue_number: number,
    body: string,
  ): Promise<{ id: number }>;
  updateIssueComment(
    owner: string,
    repo: string,
    comment_id: number,
    body: string,
  ): Promise<void>;
  deleteIssueComment(
    owner: string,
    repo: string,
    comment_id: number,
  ): Promise<void>;
  listMergedPullRequests(
    owner: string,
    repo: string,
    perPage?: number,
  ): Promise<PullRequest[]>;
  listPullRequestFiles(
    owner: string,
    repo: string,
    pull_number: number,
  ): Promise<string[]>;
  createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromSha: string,
  ): Promise<void>;
  putFileContents(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha?: string;
  }): Promise<{ commitSha: string }>;
  getFileContents(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<{ content: string; sha: string } | null>;
  createPullRequest(params: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; html_url: string }>;
}

export class GitHubClient implements GitHubClientPort {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    const { data } = await this.octokit.users.getAuthenticated();
    return { login: data.login };
  }

  async getHeadSha(
    owner: string,
    repo: string,
    branch = "main",
  ): Promise<string> {
    const { data } = await this.octokit.repos.getBranch({
      owner,
      repo,
      branch,
    });
    return data.commit.sha;
  }

  async getCheckRuns(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<CheckRun[]> {
    const { data } = await this.octokit.checks.listForRef({ owner, repo, ref });
    return data.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      html_url: run.html_url ?? "",
      head_sha: run.head_sha,
    }));
  }

  async getIssue(
    owner: string,
    repo: string,
    issue_number: number,
  ): Promise<Issue> {
    const { data } = await this.octokit.issues.get({
      owner,
      repo,
      issue_number,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      html_url: data.html_url,
      state: data.state,
      labels: data.labels
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter(Boolean),
    };
  }

  async listIssues(
    owner: string,
    repo: string,
    labels?: string[],
  ): Promise<Issue[]> {
    const { data } = await this.octokit.issues.listForRepo({
      owner,
      repo,
      state: "open",
      labels: labels?.join(","),
      per_page: 100,
    });
    return data.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      html_url: issue.html_url,
      state: issue.state,
      labels: issue.labels
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter(Boolean),
    }));
  }

  async createIssue(params: CreateIssueParams): Promise<Issue> {
    const { data } = await this.octokit.issues.create({
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      body: params.body,
      labels: params.labels,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      html_url: data.html_url,
      state: data.state,
      labels: data.labels
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter(Boolean),
    };
  }

  async updateIssueBody(params: UpdateIssueParams): Promise<void> {
    await this.octokit.issues.update({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issue_number,
      body: params.body,
    });
  }

  async listIssueComments(
    owner: string,
    repo: string,
    issue_number: number,
  ): Promise<{ id: number; body: string }[]> {
    const { data } = await this.octokit.issues.listComments({
      owner,
      repo,
      issue_number,
      per_page: 100,
    });
    return data.map((c) => ({ id: c.id, body: c.body ?? "" }));
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issue_number: number,
    body: string,
  ): Promise<{ id: number }> {
    const { data } = await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number,
      body,
    });
    return { id: data.id };
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    comment_id: number,
    body: string,
  ): Promise<void> {
    await this.octokit.issues.updateComment({ owner, repo, comment_id, body });
  }

  async deleteIssueComment(
    owner: string,
    repo: string,
    comment_id: number,
  ): Promise<void> {
    await this.octokit.issues.deleteComment({ owner, repo, comment_id });
  }

  /**
   * Lists merged pull requests sorted by merge date descending. Used by the
   * documentation loop to detect newly-merged PRs.
   */
  async listMergedPullRequests(
    owner: string,
    repo: string,
    perPage = 30,
  ): Promise<PullRequest[]> {
    const { data } = await this.octokit.pulls.list({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: perPage,
    });
    return data
      .filter((pr) => pr.merged_at !== null)
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body ?? null,
        html_url: pr.html_url,
        state: pr.state,
        merged: true,
        merged_at: pr.merged_at,
        base_ref: pr.base.ref,
        head_ref: pr.head.ref,
        head_sha: pr.head.sha,
      }));
  }

  async listPullRequestFiles(
    owner: string,
    repo: string,
    pull_number: number,
  ): Promise<string[]> {
    const { data } = await this.octokit.pulls.listFiles({
      owner,
      repo,
      pull_number,
      per_page: 100,
    });
    return data.map((f) => f.filename);
  }

  /**
   * Creates a new branch from an existing ref. Used by the doc loop to
   * branch off `main` for documentation PRs.
   */
  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromSha: string,
  ): Promise<void> {
    await this.octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: fromSha,
    });
  }

  /**
   * Creates or updates a file via the contents API. Returns the new commit SHA.
   * For new files, leave `sha` undefined; for updates, pass the existing blob sha.
   */
  async putFileContents(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha?: string;
  }): Promise<{ commitSha: string }> {
    const { data } = await this.octokit.repos.createOrUpdateFileContents({
      owner: params.owner,
      repo: params.repo,
      path: params.path,
      branch: params.branch,
      message: params.message,
      content: Buffer.from(params.content, "utf8").toString("base64"),
      sha: params.sha,
    });
    return { commitSha: data.commit.sha ?? "" };
  }

  async getFileContents(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<{ content: string; sha: string } | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });
      if (Array.isArray(data) || data.type !== "file") return null;
      const content = Buffer.from(data.content, "base64").toString("utf8");
      return { content, sha: data.sha };
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async createPullRequest(params: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; html_url: string }> {
    const { data } = await this.octokit.pulls.create({
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body,
    });
    return { number: data.number, html_url: data.html_url };
  }

  async listAppInstallations(appSlug: string): Promise<
    {
      id: number;
      accountLogin: string;
      accountType: "User" | "Organization";
      repositorySelection: "all" | "selected";
    }[]
  > {
    const all = await this.listAllInstallations();
    return all
      .filter((inst) => inst.appSlug.toLowerCase() === appSlug.toLowerCase())
      .map((inst) => ({
        id: inst.id,
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
        repositorySelection: inst.repositorySelection,
      }));
  }

  async listAllInstallations(): Promise<
    {
      id: number;
      appSlug: string;
      accountLogin: string;
      accountType: "User" | "Organization";
      repositorySelection: "all" | "selected";
    }[]
  > {
    const result = [];
    let page = 1;
    while (true) {
      const { data } =
        await this.octokit.apps.listInstallationsForAuthenticatedUser({
          per_page: 100,
          page,
        });
      for (const inst of data.installations) {
        result.push({
          id: inst.id,
          appSlug: inst.app_slug ?? "",
          accountLogin:
            inst.account && "login" in inst.account ? inst.account.login : "",
          accountType: (inst.account && "type" in inst.account
            ? inst.account.type
            : "User") as "User" | "Organization",
          repositorySelection: inst.repository_selection as "all" | "selected",
        });
      }
      if (data.installations.length < 100) break;
      page++;
    }
    return result;
  }

  async listInstallationRepos(installationId: number): Promise<string[]> {
    const all: string[] = [];
    let page = 1;
    while (true) {
      const { data } =
        await this.octokit.apps.listInstallationReposForAuthenticatedUser({
          installation_id: installationId,
          per_page: 100,
          page,
        });
      for (const repo of data.repositories) {
        all.push(repo.full_name);
      }
      if (data.repositories.length < 100) break;
      page++;
    }
    return all;
  }
}
