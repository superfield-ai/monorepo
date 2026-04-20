import { spawn, type ChildProcess } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

export interface SshOptions {
  host: string;
  user: string;
  privateKeyPem: string;
  knownHostsPath: string;
  port?: number;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshTunnelHandle {
  close: () => Promise<void>;
}

interface KeyFileHandle {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * SshClient wraps the system `ssh` and `scp` binaries via `node:child_process`.
 *
 * Strict host-key checking is always enabled. Use {@link SshClient.trustHostKey}
 * once per host to populate the configured known_hosts file before any other
 * operation. The private key is materialized to a 0600-mode temp file in
 * `os.tmpdir()` for the duration of each call and unlinked in a `finally`
 * block — even when the underlying ssh/scp invocation fails.
 */
export class SshClient {
  private readonly host: string;
  private readonly user: string;
  private readonly privateKeyPem: string;
  private readonly knownHostsPath: string;
  private readonly port: number;

  constructor(opts: SshOptions) {
    this.host = opts.host;
    this.user = opts.user;
    this.privateKeyPem = opts.privateKeyPem;
    this.knownHostsPath = opts.knownHostsPath;
    this.port = opts.port ?? 22;
  }

  private commonSshArgs(keyPath: string): string[] {
    return [
      "-i",
      keyPath,
      "-p",
      String(this.port),
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${this.knownHostsPath}`,
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "PubkeyAuthentication=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
    ];
  }

  private commonScpArgs(keyPath: string): string[] {
    return [
      "-i",
      keyPath,
      "-P",
      String(this.port),
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${this.knownHostsPath}`,
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "PubkeyAuthentication=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
    ];
  }

  /**
   * Materialize the private key in a 0600 temp file. Caller must invoke the
   * returned `cleanup()` in a `finally` block.
   */
  private async writeKeyFile(): Promise<KeyFileHandle> {
    const dir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "superfield-ssh-key-"),
    );
    const keyPath = path.join(dir, `id_${randomBytes(8).toString("hex")}`);
    let pem = this.privateKeyPem;
    if (!pem.endsWith("\n")) {
      pem += "\n";
    }
    await fsp.writeFile(keyPath, pem, { mode: 0o600 });
    // Defensive: ensure mode is 0600 even when umask interferes.
    await fsp.chmod(keyPath, 0o600);
    return {
      path: keyPath,
      cleanup: async () => {
        try {
          await fsp.rm(keyPath, { force: true });
        } catch {
          // ignore — best effort
        }
        try {
          await fsp.rm(dir, { recursive: true, force: true });
        } catch {
          // ignore — best effort
        }
      },
    };
  }

  /** Run a single command and capture full stdout/stderr. */
  async exec(command: string): Promise<SshExecResult> {
    const key = await this.writeKeyFile();
    try {
      const args = [
        ...this.commonSshArgs(key.path),
        `${this.user}@${this.host}`,
        command,
      ];
      return await runCapture("ssh", args);
    } finally {
      await key.cleanup();
    }
  }

  /**
   * Stream stdout line-by-line via `onLine`. stderr is buffered and surfaced in
   * the rejection error if the underlying process fails to spawn. The promise
   * resolves with the exit code (which may be non-zero — callers decide how to
   * handle it).
   */
  async execStream(
    command: string,
    onLine: (line: string) => void,
  ): Promise<number> {
    const key = await this.writeKeyFile();
    try {
      const args = [
        ...this.commonSshArgs(key.path),
        `${this.user}@${this.host}`,
        command,
      ];
      return await new Promise<number>((resolve, reject) => {
        const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
        const rl = createInterface({ input: child.stdout! });
        rl.on("line", (line) => {
          try {
            onLine(line);
          } catch (err) {
            reject(err);
            child.kill();
          }
        });
        let stderr = "";
        child.stderr!.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === null) {
            reject(
              new Error(
                `ssh process terminated by signal; stderr:\n${stderr}`,
              ),
            );
            return;
          }
          resolve(code);
        });
      });
    } finally {
      await key.cleanup();
    }
  }

  /** Upload a local file to a remote path via `scp`. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const key = await this.writeKeyFile();
    try {
      const args = [
        ...this.commonScpArgs(key.path),
        localPath,
        `${this.user}@${this.host}:${remotePath}`,
      ];
      const result = await runCapture("scp", args);
      if (result.exitCode !== 0) {
        throw new Error(
          `scp upload failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
    } finally {
      await key.cleanup();
    }
  }

  /**
   * Open a local-port-forward tunnel: traffic arriving on `localPort` on the
   * loopback interface is forwarded to `127.0.0.1:remotePort` on the SSH host.
   *
   * The returned handle owns the underlying ssh process; call `close()` to
   * terminate it and clean the temp key. The key file lives for the lifetime of
   * the tunnel — required because ssh re-reads it on reconnect attempts.
   */
  async tunnel(
    remotePort: number,
    localPort: number,
  ): Promise<SshTunnelHandle> {
    const key = await this.writeKeyFile();
    let cleanedUp = false;
    const cleanupKey = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await key.cleanup();
    };

    try {
      const args = [
        ...this.commonSshArgs(key.path),
        "-N",
        // Explicit IPv4 bind avoids ambiguity on dual-stack hosts where
        // `localhost` may only resolve to ::1 in /etc/hosts.
        "-L",
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        "-o",
        "ExitOnForwardFailure=yes",
        `${this.user}@${this.host}`,
      ];
      const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      await waitForTunnelReady(child, localPort, () => stderr);

      const close = async () => {
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
          try {
            child.kill("SIGTERM");
          } catch {
            resolve();
          }
        });
        await cleanupKey();
      };

      return { close };
    } catch (err) {
      await cleanupKey();
      throw err;
    }
  }

  /**
   * Scan the host's public key with `ssh-keyscan` and append it to the
   * configured `knownHostsPath`. Required before any other operation against a
   * never-before-contacted host.
   */
  async trustHostKey(): Promise<void> {
    const args = ["-p", String(this.port), "-T", "10", "-H", this.host];
    const result = await runCapture("ssh-keyscan", args);
    if (result.exitCode !== 0 || result.stdout.trim() === "") {
      throw new Error(
        `ssh-keyscan failed for ${this.host}:${this.port} (exit ${result.exitCode}): ${result.stderr.trim() || "no host key returned"}`,
      );
    }
    await fsp.mkdir(path.dirname(this.knownHostsPath), { recursive: true });
    let existing = "";
    try {
      existing = await fsp.readFile(this.knownHostsPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const next = existing + sep + result.stdout;
    await fsp.writeFile(this.knownHostsPath, next, { mode: 0o644 });
  }
}

function runCapture(
  cmd: string,
  args: string[],
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === null) {
        reject(
          new Error(
            `${cmd} terminated by signal; stderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Wait until either the local port accepts a TCP connection (tunnel ready) or
 * the ssh process exits (tunnel failed). Returns nothing — caller wraps with
 * its own handle.
 */
async function waitForTunnelReady(
  child: ChildProcess,
  localPort: number,
  getStderr: () => string,
): Promise<void> {
  const { connect } = await import("node:net");
  const deadline = Date.now() + 10_000;
  let exited = false;
  let exitCode: number | null = null;
  child.once("close", (code) => {
    exited = true;
    exitCode = code;
  });

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `ssh tunnel exited before becoming ready (code ${exitCode}); stderr:\n${getStderr()}`,
      );
    }
    const ready = await new Promise<boolean>((resolve) => {
      const sock = connect({ port: localPort, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => {
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  throw new Error(
    `ssh tunnel did not become ready within 10s; stderr:\n${getStderr()}`,
  );
}
