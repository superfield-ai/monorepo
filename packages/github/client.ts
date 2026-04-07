import { Octokit } from '@octokit/rest';

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

export class GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    const { data } = await this.octokit.users.getAuthenticated();
    return { login: data.login };
  }

  async getHeadSha(owner: string, repo: string, branch = 'main'): Promise<string> {
    const { data } = await this.octokit.repos.getBranch({ owner, repo, branch });
    return data.commit.sha;
  }

  async getCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]> {
    const { data } = await this.octokit.checks.listForRef({ owner, repo, ref });
    return data.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      html_url: run.html_url ?? '',
      head_sha: run.head_sha,
    }));
  }

  async listIssues(owner: string, repo: string, labels?: string[]): Promise<Issue[]> {
    const { data } = await this.octokit.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      labels: labels?.join(','),
      per_page: 100,
    });
    return data.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      html_url: issue.html_url,
      state: issue.state,
      labels: issue.labels
        .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
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
        .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
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

  async listAppInstallations(appSlug: string): Promise<{ id: number; accountLogin: string; accountType: 'User' | 'Organization'; repositorySelection: 'all' | 'selected' }[]> {
    const all = await this.listAllInstallations();
    return all
      .filter((inst) => inst.appSlug.toLowerCase() === appSlug.toLowerCase())
      .map((inst) => ({ id: inst.id, accountLogin: inst.accountLogin, accountType: inst.accountType, repositorySelection: inst.repositorySelection }));
  }

  async listAllInstallations(): Promise<{ id: number; appSlug: string; accountLogin: string; accountType: 'User' | 'Organization'; repositorySelection: 'all' | 'selected' }[]> {
    const result = [];
    let page = 1;
    while (true) {
      const { data } = await this.octokit.apps.listInstallationsForAuthenticatedUser({ per_page: 100, page });
      for (const inst of data.installations) {
        result.push({
          id: inst.id,
          appSlug: inst.app_slug ?? '',
          accountLogin: inst.account && 'login' in inst.account ? inst.account.login : '',
          accountType: (inst.account && 'type' in inst.account ? inst.account.type : 'User') as 'User' | 'Organization',
          repositorySelection: inst.repository_selection as 'all' | 'selected',
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
      const { data } = await this.octokit.apps.listInstallationReposForAuthenticatedUser({
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
