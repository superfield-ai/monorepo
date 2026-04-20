export interface DeployKey {
  id: number;
  key: string;
  title: string;
  read_only: boolean;
  url: string;
  created_at: string;
  verified: boolean;
}

export interface RepoPublicKey {
  key_id: string;
  key: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export interface PullRequestFile {
  path: string;
  content: string;
}

export interface GitHubHttpDeps {
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  getToken: () => Promise<string>;
}
