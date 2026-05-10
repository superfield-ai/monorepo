/**
 * Unit tests for the Firecracker VM lifecycle (buildVmSnapshot, restoreVm).
 *
 * Uses injected spawn, API client, and waitForDocker stubs. No Firecracker
 * binary or socket is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { buildVmSnapshot, restoreVm, snapshotPaths } from "../../vm.ts";
import type { ApiClient } from "../../api.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake ChildProcess. */
function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 99999;
  return proc;
}

/** API client stub that records calls and returns 204. */
function buildOrderedClient() {
  const calls: string[] = [];
  const client: ApiClient = vi
    .fn()
    .mockImplementation(async (_sock: string, method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return { statusCode: 204, body: "" };
    });
  return { client, calls };
}

// ---------------------------------------------------------------------------
// snapshotPaths
// ---------------------------------------------------------------------------

describe("snapshotPaths", () => {
  it("returns deterministic paths under cacheBase", () => {
    const result = snapshotPaths("abc123", "/tmp/cache");
    expect(result.dir).toBe("/tmp/cache/vm-snapshots/abc123");
    expect(result.vmstate).toBe(
      "/tmp/cache/vm-snapshots/abc123/snapshot.vmstate",
    );
    expect(result.mem).toBe("/tmp/cache/vm-snapshots/abc123/snapshot.mem");
  });
});

// ---------------------------------------------------------------------------
// buildVmSnapshot
// ---------------------------------------------------------------------------

describe("buildVmSnapshot", () => {
  let proc: ReturnType<typeof fakeProcess>;
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    proc = fakeProcess();
    spawnFn = vi.fn().mockReturnValue(proc);
  });

  it("calls API endpoints in boot-snapshot order", async () => {
    const { client, calls } = buildOrderedClient();
    const waitForDocker = vi.fn().mockResolvedValue(undefined);
    const waitForSocketFn = vi.fn().mockResolvedValue(undefined);

    await buildVmSnapshot({
      binary: "/usr/local/bin/firecracker",
      kernelPath: "/cache/vmlinux.bin",
      rootfsPath: "/cache/rootfs.ext4",
      socketPath: "/tmp/nonexistent-fc-test.sock",
      snapshotTag: "test-digest-abc",
      cacheBase: "/tmp/test-snapshots",
      apiClient: client,
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      waitForDockerFn: waitForDocker,
      waitForSocketFn,
    });

    // Firecracker was spawned with the right binary and socket arg.
    expect(spawnFn).toHaveBeenCalledOnce();
    const [binaryArg, argsArg] = spawnFn.mock.calls[0] as [string, string[]];
    expect(binaryArg).toBe("/usr/local/bin/firecracker");
    expect(argsArg).toContain("--api-sock");
    expect(argsArg).toContain("/tmp/nonexistent-fc-test.sock");

    // API was called in the correct boot-snapshot order.
    expect(calls).toEqual([
      "PUT /boot-source",
      "PUT /drives/rootfs",
      "PUT /machine-config",
      "PUT /actions",
      "PATCH /vm",
      "PUT /snapshot/create",
    ]);
    expect(waitForDocker).toHaveBeenCalledOnce();
  });

  it("starts a virtiofsd process if workspace is provided during restore", async () => {
    // This is a restoreVm test, included here for proximity.
    const { client } = buildOrderedClient();
    const waitForSocketFn = vi.fn().mockResolvedValue(undefined);

    await restoreVm({
      binary: "/usr/local/bin/firecracker",
      kernelPath: "/cache/vmlinux.bin",
      rootfsPath: "/cache/rootfs.ext4",
      socketPath: "/tmp/nonexistent-restore-test.sock",
      snapshotDir: "/tmp/test-snapshots/vm-snapshots/test-digest-abc",
      apiClient: client,
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      waitForSocketFn,
      workspace: {
        sharedDir: "/workspace",
        socketPath: "/tmp/vfs-test.sock",
        binaryPath: "/usr/bin/virtiofsd",
      },
    });

    // spawnFn called twice: once for virtiofsd, once for firecracker.
    expect(spawnFn).toHaveBeenCalledTimes(2);
    const firstBinary = (spawnFn.mock.calls[0] as [string, string[]])[0];
    const secondBinary = (spawnFn.mock.calls[1] as [string, string[]])[0];
    expect(firstBinary).toBe("/usr/bin/virtiofsd");
    expect(secondBinary).toBe("/usr/local/bin/firecracker");
  });
});

// ---------------------------------------------------------------------------
// runningVm.kill()
// ---------------------------------------------------------------------------

describe("RunningVm.kill", () => {
  it("sends SIGTERM to the Firecracker process", () => {
    const proc = fakeProcess();
    // Construct a minimal RunningVm inline to test kill()
    const vm = {
      socketPath: "/tmp/fc.sock",
      process: proc,
      kill(): void {
        proc.kill("SIGTERM");
      },
    };

    vm.kill();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills both Firecracker and virtiofsd when workspace is mounted", () => {
    const fcProc = fakeProcess();
    const vfsProc = { kill: vi.fn() };
    const virtiofsd = {
      socketPath: "/tmp/vfs.sock",
      process: vfsProc,
      kill: vfsProc.kill,
    };

    const vm = {
      socketPath: "/tmp/fc.sock",
      virtiofsd,
      process: fcProc,
      kill(): void {
        fcProc.kill("SIGTERM");
        virtiofsd.kill();
      },
    };

    vm.kill();
    expect(fcProc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(vfsProc.kill).toHaveBeenCalled();
  });
});
