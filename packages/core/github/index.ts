export { getAuthToken } from "./auth.ts";
export type { GetAuthTokenDeps } from "./auth.ts";

export {
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  GitHubApiError,
  githubRequest,
} from "./http.ts";
export type { GithubRequestInit } from "./http.ts";

export {
  listDeployKeys,
  deleteDeployKey,
  registerDeployKey,
} from "./deploy-keys.ts";

export {
  getRepoPublicKey,
  sealedBoxEncrypt,
  putRepoSecret,
  deleteRepoSecret,
} from "./secrets.ts";

export {
  getRepoVariable,
  putRepoVariable,
  deleteRepoVariable,
} from "./variables.ts";

export { openPullRequest } from "./pull-request.ts";
export type { OpenPullRequestOptions } from "./pull-request.ts";

export type {
  DeployKey,
  GitHubHttpDeps,
  PullRequestFile,
  PullRequestResult,
  RepoPublicKey,
} from "./types.ts";

import { getAuthToken } from "./auth.ts";
import type { GitHubHttpDeps } from "./types.ts";

/**
 * Convenience: build a GitHubHttpDeps backed by `globalThis.fetch` and
 * `gh auth token`. Tests should construct deps inline rather than calling
 * this so they can inject MSW-aware fetch and pre-canned tokens.
 */
export function makeDefaultGithubDeps(): GitHubHttpDeps {
  let cached: string | null = null;
  return {
    fetch: globalThis.fetch,
    getToken: async () => {
      if (cached) return cached;
      cached = await getAuthToken();
      return cached;
    },
  };
}
