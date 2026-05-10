/**
 * Unit tests for the virtiofsd bridge module.
 *
 * Uses injected spawn stubs — no real virtiofsd process is started.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mountWorkspace } from "../../virtiofsd.ts";

/** Minimal fake ChildProcess. */
function fakeProcess() {
  const proc = new EventEmitter() as ReturnType<typeof vi.fn> &
    EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      pid: number;
    };
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 99999;
  return proc;
}

describe("mountWorkspace", () => {
  it("spawns virtiofsd with correct socket-path and shared-dir args", async () => {
    const proc = fakeProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const handle = await mountWorkspace({
      sharedDir: "/home/user/workspace",
      socketPath: "/tmp/vfs-test.sock",
      binaryPath: "/usr/bin/virtiofsd",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
    });

    expect(spawnFn).toHaveBeenCalledOnce();
    const [binaryArg, argsArg] = spawnFn.mock.calls[0] as [string, string[]];
    expect(binaryArg).toBe("/usr/bin/virtiofsd");
    expect(argsArg).toContain("--socket-path");
    expect(argsArg).toContain("/tmp/vfs-test.sock");
    expect(argsArg).toContain("--shared-dir");
    expect(argsArg).toContain("/home/user/workspace");
    expect(handle.socketPath).toBe("/tmp/vfs-test.sock");
  });

  it("generates a socket path when none is provided", async () => {
    const proc = fakeProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const handle = await mountWorkspace({
      sharedDir: "/workspace",
      binaryPath: "/usr/bin/virtiofsd",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
    });

    expect(handle.socketPath).toMatch(/superfield-virtiofsd-\d+\.sock$/);
  });

  it("kill() sends SIGTERM to the virtiofsd process", async () => {
    const proc = fakeProcess();
    const spawnFn = vi.fn().mockReturnValue(proc);

    const handle = await mountWorkspace({
      sharedDir: "/workspace",
      socketPath: "/tmp/vfs-kill-test.sock",
      binaryPath: "/usr/bin/virtiofsd",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
    });

    handle.kill();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
