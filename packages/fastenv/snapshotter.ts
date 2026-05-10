/**
 * OCI-native workspace forking via containerd overlayfs snapshotter.
 *
 * Uses the `ctr` CLI (containerd CLI tool) to manage snapshots without
 * requiring a Go client. The containerd socket at /run/containerd/containerd.sock
 * requires root or membership in the `containerd` group (see scout #281).
 *
 * Snapshot lifecycle:
 *   base (prepared, committed) ──► fork (writable layer via Prepare)
 *
 * All fork operations must complete in ≤100ms p95 on the overlayfs snapshotter.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SNAPSHOTTER = "overlayfs";
export const NAMESPACE = "fastenv";
export const CONTAINERD_SOCKET = "/run/containerd/containerd.sock";

export interface SnapshotInfo {
  key: string;
  parent: string;
  kind: "committed" | "active";
  createdAt: Date;
}

export interface ForkResult {
  forkId: string;
  baseImage: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface DiskUsage {
  forkId: string;
  /** Writable layer size in bytes (excludes the shared base). */
  writableBytes: number;
}

/**
 * Minimal abstraction over execFileAsync to allow injection in tests.
 * Production code uses the real execFileAsync; tests pass a stub.
 */
export type ExecFn = (
  cmd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

/** Default production exec using promisified execFile. */
export const defaultExec: ExecFn = async (cmd, args) => {
  const result = await execFileAsync(cmd, args);
  return { stdout: result.stdout, stderr: result.stderr ?? "" };
};

/**
 * Run a `ctr` command in the fastenv namespace.
 * Throws on non-zero exit.
 */
async function ctr(
  args: string[],
  exec: ExecFn = defaultExec
): Promise<string> {
  const { stdout } = await exec("ctr", ["--namespace", NAMESPACE, ...args]);
  return stdout.trim();
}

/**
 * Pull an OCI image into the containerd content store and commit a base
 * snapshot layer for it. Idempotent — re-run is safe if the snapshot already
 * exists.
 *
 * This implements `fastenv build-base <image>`.
 */
export async function buildBase(
  image: string,
  exec: ExecFn = defaultExec
): Promise<void> {
  // Pull the image (no-op if already present).
  await ctr(["images", "pull", image], exec);

  // Unpack the image to create the overlayfs snapshot chain.
  // `ctr images unpack` creates committed snapshots from OCI layers.
  await ctr(["images", "unpack", "--snapshotter", SNAPSHOTTER, image], exec);
}

/**
 * Fork a workspace by creating a writable overlayfs snapshot on top of the
 * base image snapshot. No file copying occurs — the kernel COW layer is the
 * only cost.
 *
 * This implements `fastenv fork --base <image> --name <forkId>`.
 *
 * @returns ForkResult with wall-clock duration for latency tracking.
 */
export async function forkWorkspace(
  baseImage: string,
  forkId: string,
  exec: ExecFn = defaultExec
): Promise<ForkResult> {
  const start = performance.now();

  // Create a container from the base image. This triggers the overlayfs
  // snapshotter to create a writable layer on top of the committed base.
  // We use a minimal spec so the container is created but not started.
  await ctr(
    [
      "containers",
      "create",
      "--snapshotter",
      SNAPSHOTTER,
      "--label",
      `fastenv.base=${baseImage}`,
      "--label",
      `fastenv.created=${new Date().toISOString()}`,
      baseImage,
      forkId,
    ],
    exec
  );

  const durationMs = performance.now() - start;
  return { forkId, baseImage, durationMs };
}

/**
 * Execute a command inside a forked workspace using an OCI runtime (crun).
 * Provides isolated mount, PID, and optional network namespaces.
 *
 * This implements `fastenv exec <forkId> -- <cmd...>`.
 */
export async function execInFork(
  forkId: string,
  cmd: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // ctr run --rm runs a process inside the container snapshot.
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const proc = spawn(
      "ctr",
      [
        "--namespace",
        NAMESPACE,
        "run",
        "--rm",
        forkId,
        `exec-${Date.now()}`,
        ...cmd,
      ],
      { stdio: ["inherit", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    proc.on("close", (code: number | null) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Measure the writable-layer disk usage of a fork (excludes shared base).
 *
 * This implements `fastenv du <forkId>`.
 */
export async function diskUsage(
  forkId: string,
  exec: ExecFn = defaultExec
): Promise<DiskUsage> {
  // `ctr snapshots mounts` returns the overlayfs mount options including
  // upperdir= which points to the writable layer directory.
  const mountInfo = await ctr(
    ["snapshots", "mounts", "--snapshotter", SNAPSHOTTER, forkId],
    exec
  );

  // Parse upperdir= from the overlayfs mount options.
  const upperDirMatch = mountInfo.match(/upperdir=([^,)]+)/);
  if (!upperDirMatch || !upperDirMatch[1]) {
    return { forkId, writableBytes: 0 };
  }

  const upperDir = upperDirMatch[1];
  const { stdout } = await exec("du", ["-sb", upperDir]);
  const bytes = parseInt(stdout.split("\t")[0] ?? "0", 10);
  return { forkId, writableBytes: isNaN(bytes) ? 0 : bytes };
}

/**
 * Show file-level diff of the writable layer vs the base snapshot.
 *
 * This implements `fastenv diff <forkId>`.
 */
export async function diffFork(
  forkId: string,
  exec: ExecFn = defaultExec
): Promise<string[]> {
  const mountInfo = await ctr(
    ["snapshots", "mounts", "--snapshotter", SNAPSHOTTER, forkId],
    exec
  );

  const upperDirMatch = mountInfo.match(/upperdir=([^,)]+)/);
  if (!upperDirMatch || !upperDirMatch[1]) {
    return [];
  }

  const upperDir = upperDirMatch[1];
  const { stdout } = await exec("find", [upperDir, "-type", "f"]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(upperDir, ""));
}

/**
 * Export the writable layer as a unified patch archive (tar).
 *
 * This implements `fastenv export-patch <forkId>`.
 */
export async function exportPatch(
  forkId: string,
  outputPath: string,
  exec: ExecFn = defaultExec
): Promise<void> {
  const mountInfo = await ctr(
    ["snapshots", "mounts", "--snapshotter", SNAPSHOTTER, forkId],
    exec
  );

  const upperDirMatch = mountInfo.match(/upperdir=([^,)]+)/);
  if (!upperDirMatch || !upperDirMatch[1]) {
    throw new Error(`No writable layer found for fork: ${forkId}`);
  }

  const upperDir = upperDirMatch[1];
  await exec("tar", ["-czf", outputPath, "-C", upperDir, "."]);
}

/**
 * Discard a fork — delete its container and writable snapshot layer.
 * Instant: the overlayfs upperdir is removed by containerd GC.
 *
 * This implements `fastenv discard <forkId>`.
 */
export async function discardFork(
  forkId: string,
  exec: ExecFn = defaultExec
): Promise<void> {
  // Remove the container (releases the snapshot reference).
  try {
    await ctr(["containers", "delete", forkId], exec);
  } catch {
    // Container may already be gone — not fatal.
  }

  // Trigger a content GC pass to reclaim the snapshot layers immediately.
  try {
    await ctr(["content", "gc", "--snapshotter", SNAPSHOTTER], exec);
  } catch {
    // GC may not be available in all ctr versions — non-fatal.
  }
}

/**
 * List all active forks (containers) in the fastenv namespace.
 */
export async function listForks(
  exec: ExecFn = defaultExec
): Promise<string[]> {
  const out = await ctr(["containers", "list", "--quiet"], exec);
  return out.split("\n").filter(Boolean);
}

/**
 * Garbage-collect forks older than `ttlMs` milliseconds.
 * Reads the `fastenv.created` label to determine age.
 */
export async function gcForks(
  ttlMs: number,
  exec: ExecFn = defaultExec
): Promise<string[]> {
  const out = await ctr(["containers", "list"], exec);
  const lines = out.split("\n").filter(Boolean);
  const now = Date.now();
  const discarded: string[] = [];

  for (const line of lines) {
    // Each line: CONTAINER  IMAGE  RUNTIME
    const id = line.split(/\s+/)[0];
    if (!id) continue;

    try {
      const info = await ctr(["containers", "info", id], exec);
      const match = info.match(/fastenv\.created=([^\s,}"]+)/);
      if (!match || !match[1]) continue;
      const created = new Date(match[1]).getTime();
      if (now - created > ttlMs) {
        await discardFork(id, exec);
        discarded.push(id);
      }
    } catch {
      // Container info may fail transiently — skip.
    }
  }

  return discarded;
}
