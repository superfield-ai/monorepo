/**
 * Firecracker binary and guest kernel provisioning.
 *
 * Downloads the Firecracker static binary and guest kernel from GitHub Releases
 * into a versioned cache directory (~/.superfield/firecracker-<version>/).
 * Idempotent: subsequent calls with the same version return the cached paths
 * without re-downloading.
 *
 * /dev/kvm must be accessible on the host (see scout #281).
 */

import { createWriteStream } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export const FIRECRACKER_VERSION = "v1.12.0";
export const FIRECRACKER_ARCH = "x86_64";

/** Resolved paths for a provisioned Firecracker installation. */
export interface FirecrackerPaths {
  /** Absolute path to the Firecracker binary. */
  binary: string;
  /** Absolute path to the guest kernel (vmlinux). */
  kernel: string;
  /** The versioned cache directory. */
  cacheDir: string;
}

export interface ProvisionOptions {
  version?: string;
  arch?: string;
  /** Override the base cache directory (default: ~/.superfield). */
  cacheBase?: string;
  /** Injected fetch for testing. */
  fetchFn?: typeof fetch;
  /** Injected fs stat for testing. */
  statFn?: (p: string) => Promise<unknown>;
  /** Injected mkdir for testing. */
  mkdirFn?: (p: string, opts?: { recursive?: boolean }) => Promise<unknown>;
  /** Injected download function for testing. */
  downloadFn?: (url: string, dest: string) => Promise<void>;
}

/**
 * Download a URL to a file path.
 * Not injected in production — use downloadFn in tests.
 */
async function downloadUrl(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const body = response.body;
  if (!body) {
    throw new Error(`Empty response body for ${url}`);
  }
  const writeStream = createWriteStream(dest);
  await pipeline(body as unknown as NodeJS.ReadableStream, writeStream);
}

/**
 * Provision the Firecracker binary and guest kernel into a versioned cache dir.
 *
 * Cache layout:
 *   <cacheBase>/firecracker-<version>/
 *     firecracker          # static binary
 *     vmlinux.bin          # guest kernel
 *
 * @returns Resolved paths to the binary and kernel.
 */
export async function provisionFirecracker(
  opts: ProvisionOptions = {},
): Promise<FirecrackerPaths> {
  const version = opts.version ?? FIRECRACKER_VERSION;
  const arch = opts.arch ?? FIRECRACKER_ARCH;
  const cacheBase = opts.cacheBase ?? join(homedir(), ".superfield");
  const cacheDir = join(cacheBase, `firecracker-${version}`);
  const binary = join(cacheDir, "firecracker");
  const kernel = join(cacheDir, "vmlinux.bin");

  const statFn = opts.statFn ?? stat;
  const mkdirFn =
    opts.mkdirFn ??
    ((p: string, o?: { recursive?: boolean }) => mkdir(p, o ?? {}));
  const downloadFn = opts.downloadFn ?? downloadUrl;

  // Ensure cache directory exists.
  await mkdirFn(cacheDir, { recursive: true });

  // Download Firecracker binary if not cached.
  const binaryMissing = await statFn(binary).then(
    () => false,
    () => true,
  );
  if (binaryMissing) {
    const tarUrl = `https://github.com/firecracker-microvm/firecracker/releases/download/${version}/firecracker-${version}-${arch}.tgz`;
    const tarDest = join(cacheDir, `firecracker-${version}-${arch}.tgz`);
    process.stderr.write(`[firecracker] downloading binary from ${tarUrl}\n`);
    await downloadFn(tarUrl, tarDest);
    // Extract using system tar — no npm dependency.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("tar", [
      "-xzf",
      tarDest,
      "--strip-components=1",
      "-C",
      cacheDir,
      "--wildcards",
      `*/firecracker-${version}-${arch}`,
    ]);
    // Rename extracted binary.
    const { rename } = await import("node:fs/promises");
    const extractedName = join(cacheDir, `firecracker-${version}-${arch}`);
    await rename(extractedName, binary).catch(async () => {
      // Some tarballs use a different naming convention — try the short name.
      const alt = join(cacheDir, "firecracker");
      await rename(alt, binary);
    });
    await chmod(binary, 0o755);
    process.stderr.write(`[firecracker] binary cached at ${binary}\n`);
  }

  // Download guest kernel if not cached.
  const kernelMissing = await statFn(kernel).then(
    () => false,
    () => true,
  );
  if (kernelMissing) {
    const kernelUrl = `https://github.com/firecracker-microvm/firecracker/releases/download/${version}/vmlinux-${version}.bin`;
    process.stderr.write(
      `[firecracker] downloading kernel from ${kernelUrl}\n`,
    );
    await downloadFn(kernelUrl, kernel);
    process.stderr.write(`[firecracker] kernel cached at ${kernel}\n`);
  }

  return { binary, kernel, cacheDir };
}
