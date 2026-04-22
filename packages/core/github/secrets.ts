import sodium from "libsodium-wrappers";

import { GitHubApiError, githubRequest } from "./http.ts";
import type { GitHubHttpDeps } from "./types.ts";

let sodiumReady: Promise<void> | null = null;

async function ensureSodium(): Promise<void> {
  if (!sodiumReady) {
    sodiumReady = sodium.ready;
  }
  await sodiumReady;
}

export async function getRepoPublicKey(
  repo: string,
  deps: GitHubHttpDeps,
): Promise<{ key_id: string; key: string }> {
  const { data } = await githubRequest<{ key_id: string; key: string }>(
    `/repos/${repo}/actions/secrets/public-key`,
    { method: "GET" },
    deps,
  );
  if (!data) {
    throw new Error(`GitHub returned no public key for ${repo}`);
  }
  return data;
}

export async function sealedBoxEncrypt(
  plaintext: string,
  publicKeyBase64: string,
): Promise<string> {
  await ensureSodium();
  const publicKey = sodium.from_base64(
    publicKeyBase64,
    sodium.base64_variants.ORIGINAL,
  );
  const message = sodium.from_string(plaintext);
  const ciphertext = sodium.crypto_box_seal(message, publicKey);
  return sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL);
}

export async function putRepoSecret(
  repo: string,
  name: string,
  value: string,
  deps: GitHubHttpDeps,
): Promise<void> {
  const publicKey = await getRepoPublicKey(repo, deps);
  const encryptedValue = await sealedBoxEncrypt(value, publicKey.key);
  await githubRequest<null>(
    `/repos/${repo}/actions/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      jsonBody: {
        encrypted_value: encryptedValue,
        key_id: publicKey.key_id,
      },
    },
    deps,
  );
}

/**
 * Delete a repository Actions secret. If the secret does not exist (404),
 * the call is silently ignored so callers are idempotent.
 */
export async function deleteRepoSecret(
  repo: string,
  name: string,
  deps: GitHubHttpDeps,
): Promise<void> {
  try {
    await githubRequest<null>(
      `/repos/${repo}/actions/secrets/${encodeURIComponent(name)}`,
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
