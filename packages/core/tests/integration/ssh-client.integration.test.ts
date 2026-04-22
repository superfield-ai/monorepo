/**
 * Integration tests for `SshClient` against a real `linuxserver/openssh-server`
 * container. No mocks — if Docker is not available or the container fails to
 * start, the entire suite is skipped with an explicit reason.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SshClient } from "../../ssh/client.ts";

const IMAGE = "linuxserver/openssh-server:latest";
const SSH_USER = "tester";

interface Fixture {
  containerName: string;
  port: number;
  privateKeyPem: string;
  publicKey: string;
  workDir: string;
  knownHostsPath: string;
}

let fixture: Fixture | undefined;
let skipReason: string | undefined;

function dockerAvailable(): boolean {
  try {
    const r = spawnSync(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
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
): Promise<{ pem: string; pub: string }> {
  const keyPath = path.join(workDir, "host_test_key");
  const r = spawnSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "ssh-client-test"],
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
    // Read the SSH banner — only sshd itself emits one starting with "SSH-".
    // The docker-proxy forwards the port before sshd is up, so a plain TCP
    // accept is not sufficient.
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
      s.once("connect", () => {
        // wait for data
      });
      s.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        if (buf.includes("\n")) {
          done(buf.split("\n", 1)[0]!);
        }
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

async function startContainer(): Promise<Fixture> {
  const workDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "ssh-client-fixture-"),
  );
  const { pem, pub } = await generateKeypair(workDir);
  const port = await freePort();
  const containerName = `ssh-client-test-${randomBytes(4).toString("hex")}`;
  const knownHostsPath = path.join(workDir, "known_hosts");

  const args = [
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-p",
    `127.0.0.1:${port}:2222`,
    "-e",
    "PUID=1000",
    "-e",
    "PGID=1000",
    "-e",
    `USER_NAME=${SSH_USER}`,
    "-e",
    `PUBLIC_KEY=${pub}`,
    "-e",
    "SUDO_ACCESS=false",
    "-e",
    "PASSWORD_ACCESS=false",
    IMAGE,
  ];
  const r = spawnSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(
      `docker run failed: ${r.stderr.toString() || r.stdout.toString()}`,
    );
  }

  try {
    await waitForSsh(port);
  } catch (err) {
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    throw err;
  }

  // The linuxserver/openssh-server image ships with `AllowTcpForwarding no`
  // baked into `/config/sshd/sshd_config`. Patch and HUP sshd so the
  // `tunnel()` test path can actually forward TCP. We do this by docker exec
  // (not a volume mount) because the active config lives at /config — which
  // is populated at container start from /defaults.
  const patch = spawnSync(
    "docker",
    [
      "exec",
      containerName,
      "sh",
      "-c",
      "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /config/sshd/sshd_config && pkill -HUP sshd.pam",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (patch.status !== 0) {
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    throw new Error(
      `failed to enable AllowTcpForwarding: ${patch.stderr.toString()}`,
    );
  }
  // sshd briefly drops connections during HUP — give it a moment to be ready.
  await new Promise((r) => setTimeout(r, 1500));

  return {
    containerName,
    port,
    privateKeyPem: pem,
    publicKey: pub,
    workDir,
    knownHostsPath,
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
    skipReason = "docker not available — skipping SshClient integration tests";
    return;
  }
  try {
    fixture = await startContainer();
    // Pre-trust the host key in the shared known_hosts once so individual
    // tests don't each re-run ssh-keyscan and overwhelm sshd's MaxStartups.
    const seedClient = new SshClient({
      host: "127.0.0.1",
      user: SSH_USER,
      privateKeyPem: fixture.privateKeyPem,
      knownHostsPath: fixture.knownHostsPath,
      port: fixture.port,
    });
    await seedClient.trustHostKey();
  } catch (err) {
    skipReason = `failed to start linuxserver/openssh-server container: ${(err as Error).message}`;
  }
}, 90_000);

afterAll(async () => {
  if (fixture) {
    await stopContainer(fixture);
  }
});

function f(): Fixture {
  if (!fixture) throw new Error(skipReason ?? "fixture not initialized");
  return fixture;
}

function makeClient(opts?: {
  port?: number;
  knownHostsPath?: string;
}): SshClient {
  const fx = f();
  return new SshClient({
    host: "127.0.0.1",
    user: SSH_USER,
    privateKeyPem: fx.privateKeyPem,
    knownHostsPath: opts?.knownHostsPath ?? fx.knownHostsPath,
    port: opts?.port ?? fx.port,
  });
}

async function listTmpKeyArtifacts(): Promise<string[]> {
  const entries = await fsp.readdir(os.tmpdir());
  return entries.filter((e) => e.startsWith("superfield-ssh-key-"));
}

describe("SshClient (integration, real sshd container)", () => {
  it("rejects connection when host key is not trusted (no MITM acceptance)", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const fx = f();
    const isolatedKnownHosts = path.join(fx.workDir, "empty_known_hosts");
    // Ensure file does not pre-exist.
    if (existsSync(isolatedKnownHosts)) {
      await fsp.rm(isolatedKnownHosts);
    }
    const client = makeClient({ knownHostsPath: isolatedKnownHosts });
    const result = await client.exec("echo nope");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.toLowerCase()).toMatch(
      /host key verification failed|no .* host key is known|strict checking/,
    );
  }, 30_000);

  it("exec returns stdout, stderr, and exit code after host key is trusted", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const client = makeClient();
    const result = await client.exec("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  }, 30_000);

  it("trustHostKey populates an empty known_hosts and enables connection", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const fx = f();
    const dedicatedKnownHosts = path.join(fx.workDir, "trust_known_hosts");
    if (existsSync(dedicatedKnownHosts)) await fsp.rm(dedicatedKnownHosts);

    const client = makeClient({ knownHostsPath: dedicatedKnownHosts });
    // Without trust, fails:
    const before = await client.exec("echo before");
    expect(before.exitCode).not.toBe(0);

    await client.trustHostKey();

    const after = await client.exec("echo after");
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toBe("after\n");
  }, 30_000);

  it("execStream delivers each stdout line", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const client = makeClient();
    const lines: string[] = [];
    const exit = await client.execStream(
      "for i in 1 2 3 4 5; do echo line-$i; done",
      (line) => lines.push(line),
    );
    expect(exit).toBe(0);
    expect(lines).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"]);
  }, 30_000);

  it("upload round-trips a 1MB file with matching checksum", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const fx = f();
    const client = makeClient();

    const payload = randomBytes(1024 * 1024);
    const expected = createHash("sha256").update(payload).digest("hex");

    const localPath = path.join(fx.workDir, "payload.bin");
    await fsp.writeFile(localPath, payload);

    const remotePath = `/config/payload-${randomBytes(4).toString("hex")}.bin`;
    await client.upload(localPath, remotePath);

    const result = await client.exec(`sha256sum ${remotePath}`);
    expect(result.exitCode).toBe(0);
    const remoteHash = result.stdout.trim().split(/\s+/)[0];
    expect(remoteHash).toBe(expected);

    // Cleanup remote artifact.
    await client.exec(`rm -f ${remotePath}`);
  }, 60_000);

  it("tunnel forwards a local port to a remote HTTP server inside the container", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const client = makeClient();

    const remotePort = 18080;
    const message = `hello-from-container-${randomBytes(3).toString("hex")}`;
    const httpResponse = `HTTP/1.1 200 OK\r\nContent-Length: ${message.length}\r\nConnection: close\r\n\r\n${message}`;

    const remoteScript = [
      "cat > /tmp/serve.sh <<'SHEOF'",
      "#!/bin/sh",
      "while true; do",
      // OpenBSD nc: -l listen, -p source port, -q 0 quit immediately after EOF
      // on stdin. The bash loop respawns it for the next connection.
      `  printf '%s' '${httpResponse}' | nc -l -p ${remotePort} -q 0 >/dev/null 2>&1 || true`,
      "done",
      "SHEOF",
      "chmod +x /tmp/serve.sh",
      "setsid /tmp/serve.sh </dev/null >/tmp/serve.log 2>&1 &",
      "echo started",
    ].join("\n");

    const startResult = await client.exec(remoteScript);
    expect(startResult.exitCode).toBe(0);

    // Wait until the remote port is actually bound before opening the tunnel.
    let bound = false;
    for (let i = 0; i < 40; i++) {
      const probe = await client.exec(
        `netstat -tln 2>/dev/null | grep -E ':${remotePort} ' || ss -tln 2>/dev/null | grep -E ':${remotePort} ' || true`,
      );
      if (probe.stdout.trim().length > 0) {
        bound = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(bound).toBe(true);

    const localPort = await freePort();
    const tunnel = await client.tunnel(remotePort, localPort);
    try {
      const { connect } = await import("node:net");
      let body = "";
      let lastErr: unknown;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          body = await new Promise<string>((resolve, reject) => {
            const s = connect({ port: localPort, host: "127.0.0.1" });
            let buf = "";
            s.setTimeout(5000);
            s.once("connect", () => {
              s.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
            });
            s.on("data", (chunk: Buffer) => {
              buf += chunk.toString("utf8");
            });
            s.once("end", () => resolve(buf));
            s.once("close", () => resolve(buf));
            s.once("error", reject);
            s.once("timeout", () => {
              s.destroy();
              reject(new Error("read timed out"));
            });
          });
          if (body.includes(message)) {
            lastErr = undefined;
            break;
          }
          lastErr = new Error(
            `response missing message: ${JSON.stringify(body)}`,
          );
        } catch (err) {
          lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (lastErr) throw lastErr;
      expect(body).toContain("HTTP/1.1 200 OK");
      expect(body).toContain(message);
    } finally {
      await tunnel.close();
      try {
        await client.exec(
          "pkill -x serve.sh 2>/dev/null; pkill -x nc 2>/dev/null; rm -f /tmp/serve.sh /tmp/serve.log; true",
        );
      } catch {
        // ignore — best effort cleanup
      }
    }
  }, 60_000);

  it("temp key file is removed after every operation", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const client = makeClient();

    // Run several distinct operations.
    await client.exec("true");
    const lines: string[] = [];
    await client.execStream("echo a; echo b", (l) => lines.push(l));

    const fx = f();
    const localPath = path.join(fx.workDir, "tiny.txt");
    await fsp.writeFile(localPath, "tiny\n");
    await client.upload(
      localPath,
      `/config/tiny-${randomBytes(3).toString("hex")}.txt`,
    );

    const leftovers = await listTmpKeyArtifacts();
    // Allow leftovers from concurrent runs only if their mtime predates this test.
    // Here the simpler invariant: there are zero leftovers because no tunnel is open.
    expect(leftovers).toEqual([]);
  }, 60_000);

  it("temp key file is removed even when exec fails (host-key rejection)", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const fx = f();
    const isolatedKnownHosts = path.join(fx.workDir, "empty_known_hosts_2");
    if (existsSync(isolatedKnownHosts)) await fsp.rm(isolatedKnownHosts);

    const client = makeClient({ knownHostsPath: isolatedKnownHosts });

    // exec resolves with non-zero exit; either way the temp key dir must be gone.
    try {
      await client.exec("echo no");
    } catch {
      // ignore
    }

    const leftovers = await listTmpKeyArtifacts();
    expect(leftovers).toEqual([]);
  }, 30_000);
});
