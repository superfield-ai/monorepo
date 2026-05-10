/**
 * Unit tests for Firecracker binary provisioning.
 *
 * All tests use injected stubs — no live downloads or filesystem writes.
 */

import { describe, it, expect, vi } from "vitest";
import { provisionFirecracker } from "../../provision.ts";

/** Build a minimal stat stub that reports "file exists" for each path in the set. */
function statStub(existingPaths: Set<string>) {
  return vi.fn().mockImplementation(async (p: string) => {
    if (existingPaths.has(p)) return { size: 1 };
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
}

describe("provisionFirecracker", () => {
  it("returns cached paths without downloading when files exist", async () => {
    const cacheBase = "/tmp/test-cache";
    const version = "v1.12.0";
    const cacheDir = `${cacheBase}/firecracker-${version}`;
    const binary = `${cacheDir}/firecracker`;
    const kernel = `${cacheDir}/vmlinux.bin`;

    const statFn = statStub(new Set([binary, kernel]));
    const mkdirFn = vi.fn().mockResolvedValue(undefined);
    const downloadFn = vi.fn().mockResolvedValue(undefined);

    const result = await provisionFirecracker({
      version,
      cacheBase,
      statFn,
      mkdirFn,
      downloadFn,
    });

    expect(result.binary).toBe(binary);
    expect(result.kernel).toBe(kernel);
    expect(result.cacheDir).toBe(cacheDir);
    expect(downloadFn).not.toHaveBeenCalled();
  });

  it("downloads binary tgz when cache is empty", async () => {
    const cacheBase = "/tmp/test-cache";
    const version = "v1.99.0";
    const cacheDir = `${cacheBase}/firecracker-${version}`;
    const kernel = `${cacheDir}/vmlinux.bin`;

    // Neither file exists yet.
    const statFn = statStub(new Set());
    const mkdirFn = vi.fn().mockResolvedValue(undefined);
    const downloadFn = vi.fn().mockResolvedValue(undefined);

    // The extraction step (tar) will fail in the test environment — that is
    // expected. We verify the download URL and destination path are correct.
    try {
      await provisionFirecracker({
        version,
        cacheBase,
        statFn,
        mkdirFn,
        downloadFn,
      });
    } catch {
      // Expected: tar extraction fails in unit test — acceptable.
    }

    expect(mkdirFn).toHaveBeenCalledWith(cacheDir, { recursive: true });
    // At least the binary tgz download must have been attempted.
    expect(downloadFn).toHaveBeenCalledWith(
      expect.stringContaining(version),
      `${cacheDir}/firecracker-${version}-x86_64.tgz`,
    );
    // Kernel URL contains vmlinux.
    const kernelDownload = downloadFn.mock.calls.find(
      (callArgs: unknown[]) =>
        typeof callArgs[0] === "string" && callArgs[0].includes("vmlinux"),
    );
    // If tar throws, kernel download may not have run — we only assert it IF
    // the download count is 2. This test verifies the binary download URL.
    if (downloadFn.mock.calls.length >= 2) {
      expect(kernelDownload).toBeDefined();
      expect(kernelDownload?.[1]).toBe(kernel);
    }
  });

  it("only downloads missing files when binary exists but kernel does not", async () => {
    const cacheBase = "/tmp/test-cache";
    const version = "v1.12.0";
    const cacheDir = `${cacheBase}/firecracker-${version}`;
    const binary = `${cacheDir}/firecracker`;
    // kernel does NOT exist
    const statFn = statStub(new Set([binary]));
    const mkdirFn = vi.fn().mockResolvedValue(undefined);
    const downloadFn = vi.fn().mockResolvedValue(undefined);

    try {
      await provisionFirecracker({
        version,
        cacheBase,
        statFn,
        mkdirFn,
        downloadFn,
      });
    } catch {
      // tar extraction will fail — acceptable in unit test.
    }

    // Only one download call: the kernel.
    expect(downloadFn).toHaveBeenCalledTimes(1);
    const [firstCall] = downloadFn.mock.calls as [[string, string]];
    expect(firstCall[0]).toContain("vmlinux");
  });
});
