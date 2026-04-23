/**
 * Integration tests for {@link bootstrapHost} against a real Ubuntu sshd
 * container. No mocks of TypeScript code: the SshClient, ssh-keyscan, scp,
 * ssh, and authorized_keys handling are all real.
 *
 * **k3s-in-docker workaround.** Running real k3s inside a docker container
 * requires --privileged + cgroups + iptables modules, which is fragile in CI
 * (and impossible inside many sandboxes). The orchestrator's contract is "run
 * install.sh, then verify a derived-key SSH session can `kubectl get nodes`
 * and see a Ready node." That contract is exercised end-to-end here by
 * substituting install.sh at the **file boundary** (the orchestrator's
 * `installScriptPath` test hatch) with a fixture POSIX-sh script that:
 *
 *   1. writes /etc/superfield/bootstrap.done (the same marker the real
 *      install.sh writes)
 *   2. replaces /root/.ssh/authorized_keys with the supplied derived key
 *      (the same authoritative behaviour as install.sh)
 *   3. installs a `kubectl` shim into /usr/local/bin that prints a fixed
 *      JSON document with one Ready node — the orchestrator parses this
 *      identically to real `kubectl get nodes -o json` output.
 *
 * The real install.sh is exhaustively covered by
 * `packages/core/bootstrap/test-install.sh` (issue #147). This test focuses
 * on the orchestrator's own responsibilities: SSH bring-up, file upload,
 * line-streaming, key rotation, and readiness polling.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootstrapHost,
  ed25519Pkcs8PemToOpenSshPem,
} from "../../bootstrap/orchestrator.ts";
import { SshClient } from "../../ssh/client.ts";
import { deriveEd25519Key } from "../../secrets/index.ts";

// A 24-word BIP-39 mnemonic used only in this test fixture.
const TEST_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

interface Fixture {
  containerName: string;
  port: number;
  initialPrivateKeyPem: string;
  initialPublicKey: string;
  derivedPublicKeyOpenSsh: string;
  derivedPrivateKeyPem: string;
  workDir: string;
  knownHostsPath: string;
  fixtureInstallScriptPath: string;
}

let fixture: Fixture | undefined;
let skipReason: string | undefined;

function dockerAvailable(): boolean {
  try {
    const r = spawnSync(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return r.status === 0 && r.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function generateKeypair(
  workDir: string,
  name: string,
): Promise<{ pem: string; pub: string }> {
  const keyPath = path.join(workDir, name);
  const r = spawnSync(
    "ssh-keygen",
    [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      keyPath,
      "-C",
      `bootstrap-orch-${name}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) {
    throw new Error(
      `ssh-keygen failed: ${r.stderr.toString() || r.stdout.toString()}`,
    );
  }
  const pem = await fsp.readFile(keyPath, "utf8");
  const pub = (await fsp.readFile(`${keyPath}.pub`, "utf8")).trim();
  return { pem, pub };
}

async function waitForSsh(port: number, timeoutMs = 60_000): Promise<void> {
  const { connect } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const banner = await new Promise<string | null>((resolve) => {
      const s = connect({ port, host: "127.0.0.1" });
      let buf = "";
      const done = (val: string | null) => {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
        resolve(val);
      };
      s.setTimeout(2000);
      s.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        if (buf.includes("\n")) done(buf.split("\n", 1)[0]!);
      });
      s.once("error", () => done(null));
      s.once("timeout", () => done(null));
      s.once("close", () => done(buf || null));
    });
    if (banner && banner.startsWith("SSH-")) return;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(
    `sshd on 127.0.0.1:${port} did not present an SSH banner within ${timeoutMs}ms`,
  );
}

const FIXTURE_INSTALL_SH = `#!/bin/sh
# Fixture install script for bootstrap-orchestrator integration test.
# Mirrors the contract of packages/core/bootstrap/install.sh from the
# orchestrator's perspective: write the marker, replace authorized_keys,
# and provide a kubectl shim that reports one Ready node. NO real apt / k3s
# operations — see the test file's header for the full rationale.
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: install.sh '<authorized-public-key>'" >&2
    exit 2
fi
AUTH_KEY="$1"

case "$AUTH_KEY" in
    "ssh-ed25519 "*) ;;
    *) echo "argument does not look like an ed25519 public key" >&2; exit 1 ;;
esac

echo "[fixture-bootstrap] starting"
echo "[fixture-bootstrap] writing kubectl shim"

mkdir -p /usr/local/bin
cat > /usr/local/bin/kubectl <<'KUBE_EOF'
#!/bin/sh
# Test shim — emits a single Ready node for any "get nodes" invocation.
case "$*" in
    *"get nodes"*)
        cat <<'JSON'
{
  "items": [
    {
      "status": {
        "conditions": [
          { "type": "Ready", "status": "True" }
        ]
      }
    }
  ]
}
JSON
        ;;
    *)
        echo "kubectl shim: unsupported args: $*" >&2
        exit 1
        ;;
esac
KUBE_EOF
chmod +x /usr/local/bin/kubectl

echo "[fixture-bootstrap] rotating authorized_keys"
mkdir -p /root/.ssh
chmod 0700 /root/.ssh
printf '%s\n' "$AUTH_KEY" > /root/.ssh/authorized_keys
chmod 0600 /root/.ssh/authorized_keys

echo "[fixture-bootstrap] writing marker"
mkdir -p /etc/superfield
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
    printf 'version=%s\n' "1"
    printf 'timestamp=%s\n' "$ts"
} > /etc/superfield/bootstrap.done
chmod 0644 /etc/superfield/bootstrap.done

echo "[fixture-bootstrap] complete"
`;

async function buildImage(): Promise<string> {
  // We bake the initial public key into authorized_keys at build time and
  // start sshd directly (no systemd) so the container is cheap and reliable.
  // The orchestrator under test then SSHes in, uploads the fixture install.sh,
  // and runs it.
  const tag = `superfield-bootstrap-orch-test:latest`;
  return tag;
}

async function startContainer(): Promise<Fixture> {
  const workDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "bootstrap-orch-fixture-"),
  );
  const initial = await generateKeypair(workDir, "initial");

  // Derive the deploy key from the test mnemonic (real `deriveEd25519Key`).
  const mnemonicBuf = Buffer.from(TEST_MNEMONIC, "utf8");
  const derived = deriveEd25519Key(mnemonicBuf, "test", "deploy");

  const port = await freePort();
  const containerName = `bootstrap-orch-test-${randomBytes(4).toString("hex")}`;
  const knownHostsPath = path.join(workDir, "known_hosts");

  // Build a small image with sshd + the initial public key pre-installed.
  const buildDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "bootstrap-orch-build-"),
  );
  await fsp.writeFile(
    path.join(buildDir, "authorized_keys"),
    `${initial.pub}\n`,
  );
  const dockerfile = `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -y \\
 && apt-get install -y --no-install-recommends openssh-server ca-certificates \\
 && apt-get clean \\
 && rm -rf /var/lib/apt/lists/* \\
 && mkdir -p /run/sshd /root/.ssh \\
 && chmod 0700 /root/.ssh
COPY authorized_keys /root/.ssh/authorized_keys
RUN chmod 0600 /root/.ssh/authorized_keys \\
 && sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \\
 && sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \\
 && ssh-keygen -A
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`;
  await fsp.writeFile(path.join(buildDir, "Dockerfile"), dockerfile);

  const tag = await buildImage();
  const build = spawnSync("docker", ["build", "-q", "-t", tag, buildDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (build.status !== 0) {
    throw new Error(
      `docker build failed: ${build.stderr.toString() || build.stdout.toString()}`,
    );
  }

  // Write the fixture install.sh to a path the orchestrator can upload.
  const fixtureInstallScriptPath = path.join(workDir, "fixture-install.sh");
  await fsp.writeFile(fixtureInstallScriptPath, FIXTURE_INSTALL_SH, {
    mode: 0o755,
  });

  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${port}:22`,
      tag,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (run.status !== 0) {
    throw new Error(
      `docker run failed: ${run.stderr.toString() || run.stdout.toString()}`,
    );
  }

  try {
    await waitForSsh(port);
  } catch (err) {
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    throw err;
  }

  return {
    containerName,
    port,
    initialPrivateKeyPem: initial.pem,
    initialPublicKey: initial.pub,
    derivedPublicKeyOpenSsh: derived.publicKeyOpenSsh,
    derivedPrivateKeyPem: derived.privateKeyPem,
    workDir,
    knownHostsPath,
    fixtureInstallScriptPath,
  };
}

async function stopContainer(f: Fixture): Promise<void> {
  spawnSync("docker", ["rm", "-f", f.containerName], { stdio: "ignore" });
  try {
    await fsp.rm(f.workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

beforeAll(async () => {
  if (!dockerAvailable()) {
    skipReason =
      "docker not available — skipping bootstrap orchestrator integration tests";
    return;
  }
  try {
    fixture = await startContainer();
  } catch (err) {
    skipReason = `failed to start ubuntu sshd container: ${(err as Error).message}`;
  }
}, 180_000);

afterAll(async () => {
  if (fixture) {
    await stopContainer(fixture);
  }
});

function f(): Fixture {
  if (!fixture) throw new Error(skipReason ?? "fixture not initialized");
  return fixture;
}

describe("bootstrapHost (integration)", () => {
  it("brings host to k3sReady, writes the marker, and rotates the deploy key", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const fx = f();
    const lines: string[] = [];

    const result = await bootstrapHost({
      host: "127.0.0.1",
      user: "root",
      port: fx.port,
      initialPrivateKeyPem: fx.initialPrivateKeyPem,
      derivedDeployKeyPublicOpenSsh: fx.derivedPublicKeyOpenSsh,
      derivedDeployKeyPrivatePem: fx.derivedPrivateKeyPem,
      knownHostsPath: fx.knownHostsPath,
      installScriptPath: fx.fixtureInstallScriptPath,
      onLine: (line) => lines.push(line),
      readinessTimeoutMs: 30_000,
      readinessIntervalMs: 500,
    });

    expect(result).toEqual({ k3sReady: true });
    // The orchestrator streamed the install script's stdout line-by-line.
    expect(lines.some((l) => l.includes("[fixture-bootstrap] starting"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("[fixture-bootstrap] complete"))).toBe(
      true,
    );

    // /etc/superfield/bootstrap.done exists on the host. Use the derived key
    // (the only one that authenticates after rotation) to verify. The derived
    // key arrives as PKCS#8 PEM from `deriveEd25519Key`; convert it to the
    // OpenSSH format `ssh -i` requires using the same helper the orchestrator
    // uses internally.
    const derivedOpenSshPem = ed25519Pkcs8PemToOpenSshPem(
      fx.derivedPrivateKeyPem,
    );
    const derivedClient = new SshClient({
      host: "127.0.0.1",
      user: "root",
      port: fx.port,
      privateKeyPem: derivedOpenSshPem,
      knownHostsPath: fx.knownHostsPath,
    });
    const marker = await derivedClient.exec(
      "test -f /etc/superfield/bootstrap.done && cat /etc/superfield/bootstrap.done",
    );
    expect(marker.exitCode).toBe(0);
    expect(marker.stdout).toContain("version=1");

    // The initial key no longer authenticates.
    const initialClient = new SshClient({
      host: "127.0.0.1",
      user: "root",
      port: fx.port,
      privateKeyPem: fx.initialPrivateKeyPem,
      knownHostsPath: fx.knownHostsPath,
    });
    const rejected = await initialClient.exec("echo nope");
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toLowerCase()).toMatch(
      /permission denied|publickey|authentication/,
    );
  }, 180_000);
});
