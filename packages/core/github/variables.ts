import { GitHubApiError, githubRequest } from "./http.ts";
import type { GitHubHttpDeps } from "./types.ts";

/**
 * Delete a repository Actions variable. If the variable does not exist (404),
 * the call is silently ignored so callers are idempotent.
 */
export async function deleteRepoVariable(
  repo: string,
  name: string,
  deps: GitHubHttpDeps,
): Promise<void> {
  try {
    await githubRequest<null>(
      `/repos/${repo}/actions/variables/${encodeURIComponent(name)}`,
      { method: "DELETE" },
      deps,
    );
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 404) {
      return;
    }
    throw e;
  }
}

interface RepoVariable {
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export async function getRepoVariable(
  repo: string,
  name: string,
  deps: GitHubHttpDeps,
): Promise<string | null> {
  try {
    const { data } = await githubRequest<RepoVariable>(
      `/repos/${repo}/actions/variables/${encodeURIComponent(name)}`,
      { method: "GET" },
      deps,
    );
    return data?.value ?? null;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function putRepoVariable(
  repo: string,
  name: string,
  value: string,
  deps: GitHubHttpDeps,
): Promise<void> {
  const existing = await getRepoVariable(repo, name, deps);
  if (existing === null) {
    await githubRequest<null>(
      `/repos/${repo}/actions/variables`,
      {
        method: "POST",
        jsonBody: { name, value },
      },
      deps,
    );
    return;
  }

  await githubRequest<null>(
    `/repos/${repo}/actions/variables/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      jsonBody: { name, value },
    },
    deps,
  );
}
