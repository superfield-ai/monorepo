import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";

import { SshClient } from "../ssh/client.ts";

/**
 * Options for {@link bootstrapHost}.
 *
 * `derivedDeployKeyPublicOpenSsh` is the OpenSSH single-line public key that
 * `install.sh` writes into `/root/.ssh/authorized_keys`. After the script runs,
 * the initial key no longer authenticates — only the derived key does. To
 * verify k3s readiness over SSH we therefore also need the matching private
 * key (Option A in the design notes for issue #148): the orchestrator opens a
 * second SSH session keyed by `derivedDeployKeyPrivatePem` and polls
 * `kubectl get nodes` until at least one node reports Ready.
 *
 * `installScriptPath` is a test-only override that lets integration tests
 * substitute a fixture script for the real installer (k3s in Docker is
 * fragile; see the integration test for the rationale). When omitted, the
 * orchestrator resolves `install.sh` next to this module.
 */
export interface BootstrapHostOptions {
  host: string;
  user: string;
  initialPrivateKeyPem: string;
  derivedDeployKeyPublicOpenSsh: string;
  derivedDeployKeyPrivatePem: string;
  knownHostsPath: string;
  port?: number;
  /** Test hatch: physical-file substitution for the install script. */
  installScriptPath?: string;
  /** Stream callback for installer stdout lines. Defaults to process.stdout. */
  onLine?: (line: string) => void;
  /** k3s readiness poll timeout in ms. Defaults to 60_000. */
  readinessTimeoutMs?: number;
  /** k3s readiness poll interval in ms. Defaults to 2_000. */
  readinessIntervalMs?: number;
}

export interface BootstrapResult {
  k3sReady: true;
}

/**
 * Bootstrap a fresh host through the install script and verify k3s comes up.
 *
 * Steps (each surfaces a named error on failure):
 *   1. trust-host-key — `ssh-keyscan` the host into `knownHostsPath`
 *   2. upload-install-script — `scp` install.sh to /root/install.sh
 *   3. run-install-script — `chmod +x` and stream the script's stdout
 *   4. k3s-readiness-check — poll `kubectl get nodes -o json` with the
 *      derived key until at least one node reports `Ready` (default 60s).
 */
export async function bootstrapHost(
  opts: BootstrapHostOptions,
): Promise<BootstrapResult> {
  const onLine =
    opts.onLine ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 60_000;
  const readinessIntervalMs = opts.readinessIntervalMs ?? 2_000;
  const installScriptPath =
    opts.installScriptPath ?? defaultInstallScriptPath();

  // Validate the install script exists locally before touching the network so
  // we fail fast with a clear error.
  try {
    await fsp.access(installScriptPath);
  } catch (err) {
    throw new Error(
      `install-script-missing: ${installScriptPath}: ${(err as Error).message}`,
    );
  }

  const initialClient = new SshClient({
    host: opts.host,
    user: opts.user,
    privateKeyPem: opts.initialPrivateKeyPem,
    knownHostsPath: opts.knownHostsPath,
    port: opts.port,
  });

  // Step 1: trust the host key on first contact.
  try {
    await initialClient.trustHostKey();
  } catch (err) {
    throw new Error(`trust-host-key failed: ${(err as Error).message}`);
  }

  // Step 2: upload install.sh to /root/install.sh.
  try {
    await initialClient.upload(installScriptPath, "/root/install.sh");
  } catch (err) {
    throw new Error(`upload-install-script failed: ${(err as Error).message}`);
  }

  // Step 3: chmod +x and run, streaming stdout line-by-line.
  const quotedKey = singleQuote(opts.derivedDeployKeyPublicOpenSsh);
  const cmd = `chmod +x /root/install.sh && /root/install.sh ${quotedKey}`;
  let exitCode: number;
  try {
    exitCode = await initialClient.execStream(cmd, onLine);
  } catch (err) {
    throw new Error(`run-install-script failed: ${(err as Error).message}`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `run-install-script failed: install.sh exited with code ${exitCode}`,
    );
  }

  // Step 4: re-connect with the derived key and poll k3s for readiness.
  // The derived key arrives as a PKCS#8 PEM (the format `deriveEd25519Key`
  // exports). OpenSSH's `ssh -i` does not accept PKCS#8 for Ed25519 — it
  // requires the OpenSSH private key format. Convert before handing to the
  // SshClient.
  const derivedOpenSshPem = ed25519Pkcs8PemToOpenSshPem(
    opts.derivedDeployKeyPrivatePem,
  );
  const derivedClient = new SshClient({
    host: opts.host,
    user: opts.user,
    privateKeyPem: derivedOpenSshPem,
    knownHostsPath: opts.knownHostsPath,
    port: opts.port,
  });

  const deadline = Date.now() + readinessTimeoutMs;
  let lastErr: string | undefined;
  while (Date.now() < deadline) {
    const result = await derivedClient.exec("kubectl get nodes -o json");
    if (result.exitCode === 0) {
      const ready = parseAnyNodeReady(result.stdout);
      if (ready) {
        return { k3sReady: true };
      }
      lastErr = "no node reports Ready yet";
    } else {
      lastErr = result.stderr.trim() || `exit ${result.exitCode}`;
    }
    await new Promise((r) => setTimeout(r, readinessIntervalMs));
  }
  throw new Error(
    `k3s readiness check timed out after ${readinessTimeoutMs}ms: ${lastErr ?? "unknown"}`,
  );
}

function defaultInstallScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "install.sh");
}

/** Wrap an SSH-bound argument in single quotes, escaping embedded quotes. */
function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface KubectlNodeList {
  items?: Array<{
    status?: {
      conditions?: Array<{ type?: string; status?: string }>;
    };
  }>;
}

/**
 * Convert a PKCS#8 PEM Ed25519 private key (as produced by `deriveEd25519Key`
 * from `packages/core/secrets`) into the OpenSSH private key format that
 * `ssh -i` accepts. OpenSSH 8.x rejects PKCS#8 PEM for Ed25519 with
 * "invalid format" — see openssh/openssh-portable#... — so we re-frame the
 * raw 32-byte seed and 32-byte public key using OpenSSH's documented binary
 * layout (PROTOCOL.key in the OpenSSH source tree).
 */
export function ed25519Pkcs8PemToOpenSshPem(pkcs8Pem: string): string {
  // Extract raw 32-byte seed + derive 32-byte public key.
  const privateKey = createPrivateKey({
    key: pkcs8Pem,
    format: "pem",
    type: "pkcs8",
  });
  const pkcs8Der = privateKey.export({
    format: "der",
    type: "pkcs8",
  }) as Buffer;
  // PKCS#8 for Ed25519 is the 16-byte fixed prefix used by `secrets/index.ts`
  // followed by the 32-byte raw seed. Slice the trailing 32 bytes.
  const seed = pkcs8Der.subarray(pkcs8Der.length - 32);
  if (seed.length !== 32) {
    throw new Error("ed25519 PKCS#8 did not yield a 32-byte seed");
  }
  const publicKey = createPublicKey(privateKey);
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // SPKI for Ed25519 is a 12-byte fixed prefix followed by the 32-byte raw
  // public key.
  const pub = spkiDer.subarray(spkiDer.length - 32);
  if (pub.length !== 32) {
    throw new Error("ed25519 SPKI did not yield a 32-byte public key");
  }

  const algo = Buffer.from("ssh-ed25519", "utf8");
  const comment = Buffer.from("superfield-derived", "utf8");

  // Build the unencrypted public key blob: ssh-string("ssh-ed25519") +
  // ssh-string(pubkey).
  const publicBlob = Buffer.concat([sshString(algo), sshString(pub)]);

  // Build the unencrypted private section.
  const checkint = randomBytes(4);
  // OpenSSH stores the Ed25519 private as the 64-byte concatenation of
  // seed + public key.
  const privKey64 = Buffer.concat([seed, pub]);
  const privSectionUnpadded = Buffer.concat([
    checkint,
    checkint,
    sshString(algo),
    sshString(pub),
    sshString(privKey64),
    sshString(comment),
  ]);
  // Pad to a multiple of 8 with the byte sequence 1, 2, 3, ...
  const padLen = (8 - (privSectionUnpadded.length % 8)) % 8;
  const padding = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) padding[i] = i + 1;
  const privSection = Buffer.concat([privSectionUnpadded, padding]);

  const magic = Buffer.from("openssh-key-v1\0", "binary");
  const none = Buffer.from("none", "utf8");
  const empty = Buffer.alloc(0);
  const numKeys = Buffer.alloc(4);
  numKeys.writeUInt32BE(1, 0);

  const body = Buffer.concat([
    magic,
    sshString(none), // ciphername
    sshString(none), // kdfname
    sshString(empty), // kdfoptions
    numKeys,
    sshString(publicBlob),
    sshString(privSection),
  ]);

  // PEM-wrap the body with a 70-character line width.
  const b64 = body.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 70) {
    lines.push(b64.slice(i, i + 70));
  }
  return [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ...lines,
    "-----END OPENSSH PRIVATE KEY-----",
    "",
  ].join("\n");
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function parseAnyNodeReady(stdout: string): boolean {
  let parsed: KubectlNodeList;
  try {
    parsed = JSON.parse(stdout) as KubectlNodeList;
  } catch {
    return false;
  }
  const items = parsed.items ?? [];
  for (const item of items) {
    const conds = item.status?.conditions ?? [];
    for (const c of conds) {
      if (c.type === "Ready" && c.status === "True") {
        return true;
      }
    }
  }
  return false;
}
