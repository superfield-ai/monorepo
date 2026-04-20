import { Buffer } from "node:buffer";

import { GitHubApiError, githubRequest } from "./http.ts";
import type {
  GitHubHttpDeps,
  PullRequestFile,
  PullRequestResult,
} from "./types.ts";

interface BranchRef {
  ref: string;
  object: { sha: string; type: string };
}

interface ContentItem {
  type: string;
  sha: string;
  content?: string;
  encoding?: string;
}

interface CreatedPullRequest {
  number: number;
  html_url: string;
}

async function getBranchSha(
  repo: string,
  branch: string,
  deps: GitHubHttpDeps,
): Promise<string | null> {
  try {
    const { data } = await githubRequest<BranchRef>(
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { method: "GET" },
      deps,
    );
    return data?.object.sha ?? null;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function ensureBranch(
  repo: string,
  branch: string,
  base: string,
  deps: GitHubHttpDeps,
): Promise<string> {
  const existing = await getBranchSha(repo, branch, deps);
  if (existing) return existing;

  const baseSha = await getBranchSha(repo, base, deps);
  if (!baseSha) {
    throw new Error(
      `Base branch '${base}' does not exist in ${repo}; cannot create '${branch}'`,
    );
  }

  await githubRequest<BranchRef>(
    `/repos/${repo}/git/refs`,
    {
      method: "POST",
      jsonBody: {
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      },
    },
    deps,
  );
  return baseSha;
}

async function getFileSha(
  repo: string,
  path: string,
  ref: string,
  deps: GitHubHttpDeps,
): Promise<string | null> {
  try {
    const { data } = await githubRequest<ContentItem>(
      `/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
      { method: "GET" },
      deps,
    );
    if (!data || Array.isArray(data)) return null;
    return data.sha ?? null;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function putFile(
  repo: string,
  branch: string,
  file: PullRequestFile,
  message: string,
  deps: GitHubHttpDeps,
): Promise<void> {
  const sha = await getFileSha(repo, file.path, branch, deps);
  await githubRequest<unknown>(
    `/repos/${repo}/contents/${encodeURI(file.path)}`,
    {
      method: "PUT",
      jsonBody: {
        message,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      },
    },
    deps,
  );
}

export interface OpenPullRequestOptions {
  files?: PullRequestFile[];
  commitMessage?: string;
}

export async function openPullRequest(
  repo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  deps: GitHubHttpDeps,
  options: OpenPullRequestOptions = {},
): Promise<PullRequestResult> {
  await ensureBranch(repo, branch, base, deps);

  if (options.files && options.files.length > 0) {
    const message = options.commitMessage ?? title;
    for (const file of options.files) {
      await putFile(repo, branch, file, message, deps);
    }
  }

  const { data } = await githubRequest<CreatedPullRequest>(
    `/repos/${repo}/pulls`,
    {
      method: "POST",
      jsonBody: {
        title,
        body,
        head: branch,
        base,
      },
    },
    deps,
  );

  if (!data) {
    throw new Error(`GitHub returned no body when opening PR in ${repo}`);
  }
  return { number: data.number, url: data.html_url };
}
