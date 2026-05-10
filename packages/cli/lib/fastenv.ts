/**
 * Thin shim for the `fastenv` binary (superfield-ai/fastenv).
 *
 * fastenv provides OCI-native copy-on-write workspace forking via containerd.
 * Each fork is a writable overlayfs snapshot on top of an immutable base image.
 * The `mount-path` subcommand exposes the host-side merged overlay path so that
 * virtiofsd can share it into a Firecracker VM.
 *
 * Required fastenv subcommands:
 *   fork --base <image> --name <id>   Create a COW workspace fork
 *   mount-path <id>                   Print the overlayfs merged path (stdout)
 *   discard <id>                      Remove the fork's writable layer
 *
 * See: https://github.com/superfield-ai/fastenv
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FastenvOptions {
  /** Path to the fastenv binary. Defaults to "fastenv" (looked up on $PATH). */
  binaryPath?: string;
}

/**
 * Create a COW workspace fork from a named base image.
 * Target: p95 ≤ 100ms fork creation latency.
 */
export async function forkWorkspace(
  baseImage: string,
  forkId: string,
  opts: FastenvOptions = {},
): Promise<void> {
  const bin = opts.binaryPath ?? "fastenv";
  await execFileAsync(bin, ["fork", "--base", baseImage, "--name", forkId]);
}

/**
 * Return the host-side overlayfs merged directory for a fork.
 * This path can be passed directly to virtiofsd as sharedDir.
 *
 * Requires fastenv >= v1 with the `mount-path` subcommand.
 */
export async function getForkMountPath(
  forkId: string,
  opts: FastenvOptions = {},
): Promise<string> {
  const bin = opts.binaryPath ?? "fastenv";
  const { stdout } = await execFileAsync(bin, ["mount-path", forkId]);
  const path = stdout.trim();
  if (!path) throw new Error(`fastenv mount-path returned empty for ${forkId}`);
  return path;
}

/**
 * Discard a fork and release its writable layer. Best-effort — never throws.
 */
export async function discardFork(
  forkId: string,
  opts: FastenvOptions = {},
): Promise<void> {
  const bin = opts.binaryPath ?? "fastenv";
  await execFileAsync(bin, ["discard", forkId]).catch(() => {});
}
