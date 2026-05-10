/**
 * virtiofsd host-guest filesystem bridge.
 *
 * Starts a virtiofsd process that exposes a host directory to the Firecracker
 * VM via virtio-fs. The VM can then mount the shared directory at any path
 * (e.g. /workspace).
 *
 * virtiofsd binary is not available as a system package on Ubuntu 22.04.
 * It must be provisioned separately (see scout #281 recommendation: bundle
 * a pre-built static binary alongside Firecracker).
 *
 * Socket path convention: /tmp/superfield-virtiofsd-<id>.sock
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Options for starting a virtiofsd instance. */
export interface VirtiofsdOptions {
  /** Host directory to share into the VM. */
  sharedDir: string;
  /** Unix socket path the VM will connect to. */
  socketPath?: string;
  /** Absolute path to the virtiofsd binary. Defaults to finding it on $PATH. */
  binaryPath?: string;
  /** Log level: error | warn | info | debug. Default: error. */
  logLevel?: "error" | "warn" | "info" | "debug";
  /** Injected spawn function for testing. */
  spawnFn?: typeof spawn;
}

/** A running virtiofsd instance. */
export interface VirtiofsdProcess {
  /** Unix socket path the guest virtio-fs device connects to. */
  socketPath: string;
  /** Kill the daemon and release the socket. */
  kill(): void;
  /** The underlying child process (exposed for testing). */
  process: ChildProcess;
}

/**
 * Locate the virtiofsd binary.
 *
 * Search order:
 *   1. binaryPath if provided — returned immediately without filesystem check
 *   2. VIRTIOFSD_PATH env var
 *   3. /usr/lib/virtiofsd/virtiofsd (common distro path)
 *   4. /snap/lxd/current/bin/virtiofsd (LXD snap path on Ubuntu)
 *   5. "virtiofsd" on $PATH (fallback — may fail at runtime)
 */
export async function findVirtiofsdBinary(
  binaryPath?: string,
): Promise<string> {
  // If an explicit path is provided, trust it without a stat check.
  if (binaryPath) return binaryPath;

  const candidates: string[] = [];

  if (process.env["VIRTIOFSD_PATH"]) {
    candidates.push(process.env["VIRTIOFSD_PATH"]);
  }
  candidates.push(
    "/usr/lib/virtiofsd/virtiofsd",
    "/snap/lxd/current/bin/virtiofsd",
  );

  for (const candidate of candidates) {
    const found = await stat(candidate)
      .then(() => true)
      .catch(() => false);
    if (found) return candidate;
  }

  // Fall back to PATH — may fail at runtime if not found.
  return "virtiofsd";
}

/**
 * Start a virtiofsd daemon that shares `sharedDir` over a Unix socket.
 *
 * The daemon runs as a child process; call `.kill()` on the returned handle
 * to stop it and clean up the socket.
 *
 * @returns A VirtiofsdProcess handle with the socket path.
 */
export async function mountWorkspace(
  opts: VirtiofsdOptions,
): Promise<VirtiofsdProcess> {
  const socketPath =
    opts.socketPath ??
    join(tmpdir(), `superfield-virtiofsd-${Date.now()}.sock`);
  const binary = await findVirtiofsdBinary(opts.binaryPath);
  const logLevel = opts.logLevel ?? "error";
  const spawnFn = opts.spawnFn ?? spawn;

  const args = [
    "--socket-path",
    socketPath,
    "--shared-dir",
    opts.sharedDir,
    "--log-level",
    logLevel,
    // Run in foreground (no daemonize flag needed for child process management).
    "--sandbox",
    "none",
  ];

  const proc = spawnFn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      process.stderr.write(`[virtiofsd] ${line}\n`);
    }
  });

  return {
    socketPath,
    process: proc,
    kill(): void {
      proc.kill("SIGTERM");
    },
  };
}
