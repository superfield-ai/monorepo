import { createHash } from "node:crypto";

import { deriveEd25519Key } from "../secrets/index.ts";
import {
  listDeployKeys,
  registerDeployKey,
} from "../github/deploy-keys.ts";
import { putRepoSecret } from "../github/secrets.ts";
import { getRepoVariable, putRepoVariable } from "../github/variables.ts";
import { makeDefaultGithubDeps } from "../github/index.ts";
import type { GitHubHttpDeps } from "../github/types.ts";

export interface RegisterEnvDeployKeyOptions {
  /** Application repository in `owner/name` form. */
  repo: string;
  /** Logical environment slug, e.g. "demo", "staging", "prod". */
  env: string;
  /**
   * BIP-39 mnemonic. The caller is responsible for sourcing this (typically
   * via `readMnemonic()`); the buffer is passed straight to
   * `deriveEd25519Key`, which zeroes it before returning.
   */
  mnemonic: Buffer;
  /**
   * Optional dependency injection for tests. Defaults to a real fetch + the
   * `gh auth token` token source.
   */
  deps?: GitHubHttpDeps;
}

export interface RegisterEnvDeployKeyResult {
  /** GitHub deploy-key id. Stable across runs once the key is registered. */
  keyId: number;
  /**
   * `true` when the freshly-derived key differed from the previously-recorded
   * fingerprint and we therefore (re)uploaded the `DEPLOY_KEY_<ENV>` secret
   * and the matching `DEPLOY_KEY_<ENV>_FP` variable. `false` when the
   * fingerprint matched and we left both alone.
   */
  secretWritten: boolean;
}

/**
 * Idempotently register a per-environment SSH deploy key on the application
 * repo and store the matching private key as the `DEPLOY_KEY_<ENV>` Actions
 * secret.
 *
 * Steps:
 *   1. Derive an Ed25519 keypair from the mnemonic under namespace
 *      `v1/<env>/ssh-deploy-key`.
 *   2. List the repo's existing deploy keys; reuse a match or register a new
 *      `superfield-deploy-<env>` (read-only) key.
 *   3. Compare the OpenSSH SHA-256 fingerprint against the recorded
 *      `DEPLOY_KEY_<ENV>_FP` repo variable. If they match, skip secret
 *      upload; otherwise upload the private key as `DEPLOY_KEY_<ENV>` and
 *      update the variable.
 *
 * The mnemonic Buffer supplied in `opts.mnemonic` is zeroed by
 * `deriveEd25519Key` before this function returns.
 */
export async function registerEnvDeployKey(
  opts: RegisterEnvDeployKeyOptions,
): Promise<RegisterEnvDeployKeyResult> {
  const deps = opts.deps ?? makeDefaultGithubDeps();
  const envUpper = opts.env.toUpperCase();
  const secretName = `DEPLOY_KEY_${envUpper}`;
  const fingerprintVarName = `DEPLOY_KEY_${envUpper}_FP`;
  const title = `superfield-deploy-${opts.env}`;

  const { publicKeyOpenSsh, privateKeyPem } = deriveEd25519Key(
    opts.mnemonic,
    opts.env,
    "ssh-deploy-key",
  );

  try {
    const fingerprint = sshSha256Fingerprint(publicKeyOpenSsh);

    const existing = await listDeployKeys(opts.repo, deps);
    const desiredBody = openSshKeyBody(publicKeyOpenSsh);
    let keyId: number | undefined;
    for (const key of existing) {
      if (openSshKeyBody(key.key) === desiredBody) {
        keyId = key.id;
        break;
      }
    }
    if (keyId === undefined) {
      const registered = await registerDeployKey(
        opts.repo,
        title,
        publicKeyOpenSsh,
        true,
        deps,
      );
      keyId = registered.id;
    }

    const recordedFingerprint = await getRepoVariable(
      opts.repo,
      fingerprintVarName,
      deps,
    );
    if (recordedFingerprint === fingerprint) {
      return { keyId, secretWritten: false };
    }

    await putRepoSecret(opts.repo, secretName, privateKeyPem, deps);
    await putRepoVariable(opts.repo, fingerprintVarName, fingerprint, deps);

    return { keyId, secretWritten: true };
  } finally {
    // Best-effort: scrub the PEM string from the local closure so casual heap
    // dumps cannot recover it. The string is immutable, so we cannot zero it
    // in place; dropping the binding is the most we can do here.
    // (intentional no-op assignment — keeps lint happy and documents intent.)
    void privateKeyPem;
  }
}

/**
 * Compute the OpenSSH-style SHA-256 fingerprint of an OpenSSH public key
 * (`SHA256:<base64-no-padding>`), matching `ssh-keygen -lf <key> -E sha256`.
 */
export function sshSha256Fingerprint(publicKeyOpenSsh: string): string {
  const body = openSshKeyBody(publicKeyOpenSsh);
  const raw = Buffer.from(body, "base64");
  const digest = createHash("sha256").update(raw).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

function openSshKeyBody(openSsh: string): string {
  const parts = openSsh.trim().split(/\s+/);
  if (parts.length < 2) return openSsh.trim();
  return parts[1]!;
}
