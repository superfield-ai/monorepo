import { createHash } from "node:crypto";

import { deriveEd25519Key, deriveHmacToken } from "../secrets/index.ts";
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

export interface PushEnvSecretsOptions {
  /** Application repository in `owner/name` form. */
  repo: string;
  /** Logical environment slug, e.g. "demo", "staging", "prod". */
  env: string;
  /** Deploy host (typically the provisioner's public IP / DNS name). */
  host: string;
  /**
   * Application database URL. For managed targets this is the provisioner's
   * output; for the local k3s mode this is the in-cluster service URL.
   */
  databaseUrl: string;
  /**
   * BIP-39 mnemonic. Will be zeroed before this function returns. The caller
   * must not reuse the buffer.
   */
  mnemonic: Buffer;
  /**
   * Optional dependency injection for tests. Defaults to a real fetch + the
   * `gh auth token` token source.
   */
  deps?: GitHubHttpDeps;
}

export interface PushEnvSecretsResult {
  /** Secret names whose values were (re)uploaded. */
  uploaded: string[];
  /**
   * Secret names that were skipped because the SHA-256 fingerprint of the
   * derived/supplied value matched the recorded `<NAME>_FP` repo variable.
   */
  skipped: string[];
}

/**
 * Idempotently push the per-environment Actions secrets that are not the
 * deploy key (which is owned by `registerEnvDeployKey`).
 *
 * Pushed secrets (UPPERCASE_<ENV> suffix):
 *   - `DEPLOY_HOST_<ENV>`     ← `opts.host`
 *   - `DATABASE_URL_<ENV>`    ← `opts.databaseUrl`
 *   - `WEBHOOK_SECRET_<ENV>`  ← `deriveHmacToken(mnemonic, env, "webhook-secret", 32)`
 *   - `COOKIE_SECRET_<ENV>`   ← `deriveHmacToken(mnemonic, env, "cookie-secret", 32)`
 *
 * For each, we compute SHA-256 of the value, compare it to the existing
 * `<NAME>_FP` repo variable, and skip the upload if they match. Otherwise we
 * call `putRepoSecret` and `putRepoVariable` for the new fingerprint.
 *
 * Plain-text secret values are NEVER written to stdout or stderr by this
 * function — callers should likewise restrict their own logging to the
 * returned name lists.
 */
export async function pushEnvSecrets(
  opts: PushEnvSecretsOptions,
): Promise<PushEnvSecretsResult> {
  const deps = opts.deps ?? makeDefaultGithubDeps();
  const envUpper = opts.env.toUpperCase();

  // Derive the two secret tokens from the mnemonic. `deriveHmacToken` zeroes
  // its mnemonic argument, so we duplicate the buffer for the first call and
  // pass the original (which still holds the bytes) to the second. The
  // duplicate is zeroed in the `finally` block at the bottom of this fn.
  const mnemonicCopy = Buffer.from(opts.mnemonic);
  let webhookSecret: string | undefined;
  let cookieSecret: string | undefined;
  try {
    webhookSecret = deriveHmacToken(
      mnemonicCopy,
      opts.env,
      "webhook-secret",
      32,
    );
    cookieSecret = deriveHmacToken(
      opts.mnemonic,
      opts.env,
      "cookie-secret",
      32,
    );

    const targets: Array<{ name: string; value: string }> = [
      { name: `DEPLOY_HOST_${envUpper}`, value: opts.host },
      { name: `DATABASE_URL_${envUpper}`, value: opts.databaseUrl },
      { name: `WEBHOOK_SECRET_${envUpper}`, value: webhookSecret },
      { name: `COOKIE_SECRET_${envUpper}`, value: cookieSecret },
    ];

    const uploaded: string[] = [];
    const skipped: string[] = [];

    for (const target of targets) {
      const fpName = `${target.name}_FP`;
      const fp = sha256Fingerprint(target.value);
      const recorded = await getRepoVariable(opts.repo, fpName, deps);
      if (recorded === fp) {
        skipped.push(target.name);
        continue;
      }
      await putRepoSecret(opts.repo, target.name, target.value, deps);
      await putRepoVariable(opts.repo, fpName, fp, deps);
      uploaded.push(target.name);
    }

    return { uploaded, skipped };
  } finally {
    // Best-effort scrub of the closure-local copy. The derived hex strings
    // are immutable; dropping the bindings is the most we can do.
    mnemonicCopy.fill(0);
    // Defensive re-zero of the caller's buffer in case `deriveHmacToken`
    // ever changes its zero-on-finally contract.
    opts.mnemonic.fill(0);
    webhookSecret = undefined;
    cookieSecret = undefined;
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

/**
 * SHA-256 fingerprint of a UTF-8 string, formatted as `sha256:<hex>`. Stored
 * as a non-secret repo variable so re-runs can detect unchanged values
 * without holding the secret server-side.
 */
export function sha256Fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
