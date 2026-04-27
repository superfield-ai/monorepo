import { GitHubApiError, githubRequest } from "./http.ts";
import type { DeployKey, GitHubHttpDeps } from "./types.ts";

/**
 * Returns the public key material body of an OpenSSH key (without the type
 * prefix, comment, or trailing whitespace). GitHub stores the deploy key in
 * `key` field as `<type> <base64>` (no comment), so we compare on the base64
 * portion to detect duplicates regardless of optional comments.
 */
function publicKeyBody(openSsh: string): string {
  const trimmed = openSsh.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts[1] === undefined) return trimmed;
  return parts[1];
}

export async function listDeployKeys(
  repo: string,
  deps: GitHubHttpDeps,
): Promise<DeployKey[]> {
  const { data } = await githubRequest<DeployKey[]>(
    `/repos/${repo}/keys`,
    { method: "GET" },
    deps,
  );
  return data ?? [];
}

export async function deleteDeployKey(
  repo: string,
  keyId: number,
  deps: GitHubHttpDeps,
): Promise<void> {
  await githubRequest<null>(
    `/repos/${repo}/keys/${keyId}`,
    { method: "DELETE" },
    deps,
  );
}

export async function registerDeployKey(
  repo: string,
  title: string,
  publicKeyOpenSsh: string,
  readOnly: boolean,
  deps: GitHubHttpDeps,
): Promise<{ id: number }> {
  const desiredBody = publicKeyBody(publicKeyOpenSsh);

  // Idempotency: check existing keys first.
  const existing = await listDeployKeys(repo, deps);
  for (const key of existing) {
    if (publicKeyBody(key.key) === desiredBody) {
      return { id: key.id };
    }
  }

  try {
    const { data } = await githubRequest<DeployKey>(
      `/repos/${repo}/keys`,
      {
        method: "POST",
        jsonBody: {
          title,
          key: publicKeyOpenSsh,
          read_only: readOnly,
        },
      },
      deps,
    );
    if (!data) {
      throw new Error(
        `GitHub returned no body when registering deploy key for ${repo}`,
      );
    }
    return { id: data.id };
  } catch (error) {
    // Race condition: another caller registered the key between our list and
    // create. Re-list and resolve.
    if (
      error instanceof GitHubApiError &&
      (error.status === 422 || error.status === 409)
    ) {
      const refreshed = await listDeployKeys(repo, deps);
      for (const key of refreshed) {
        if (publicKeyBody(key.key) === desiredBody) {
          return { id: key.id };
        }
      }
    }
    throw error;
  }
}
