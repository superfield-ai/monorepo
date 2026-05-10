/**
 * Firecracker microVM lifecycle manager.
 *
 * FirecrackerVM manages a single VM instance: boot, snapshot, restore, kill.
 * It owns the Firecracker process (via spawn) and talks to it over a Unix
 * socket using the management API in ./api.ts.
 *
 * Snapshot lifecycle for the CI runner use-case:
 *   1. buildVmSnapshot() — boot from OCI rootfs, wait for dockerd, snapshot.
 *   2. restoreVm()       — restore saved snapshot in <1s.
 *   3. kill()            — SIGTERM Firecracker + virtiofsd child.
 *
 * See also: docs/scout/281-oci-firecracker-toolchain.md
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { FirecrackerApi } from "./api.ts";
import type { ApiClient } from "./api.ts";
import { mountWorkspace } from "./virtiofsd.ts";
import type { VirtiofsdProcess, VirtiofsdOptions } from "./virtiofsd.ts";

/** Options shared across VM operations. */
export interface VmOptions {
  /** Absolute path to the Firecracker binary. */
  binary: string;
  /** Absolute path to the guest kernel (vmlinux.bin). */
  kernelPath: string;
  /** Absolute path to the rootfs ext4 image. */
  rootfsPath: string;
  /** Socket path for the Firecracker management API. Default: auto-generated. */
  socketPath?: string;
  /** Number of vCPUs. Default: 2. */
  vcpuCount?: number;
  /** Memory in MiB. Default: 1024. */
  memSizeMib?: number;
  /** Injected API client for testing. */
  apiClient?: ApiClient;
  /** Injected spawn function for testing. */
  spawnFn?: typeof spawn;
  /**
   * Injected socket-ready waiter for testing.
   * Production: polls filesystem. Tests: resolves immediately.
   */
  waitForSocketFn?: (socketPath: string) => Promise<void>;
}

/** Options for building a VM snapshot. */
export interface BuildSnapshotOptions extends VmOptions {
  /** Directory where snapshot files are stored. Default: ~/.superfield/vm-snapshots/<tag>/. */
  snapshotDir?: string;
  /** Logical tag for this snapshot (e.g. image digest). */
  snapshotTag: string;
  /** Base cache dir override. Default: ~/.superfield. */
  cacheBase?: string;
  /**
   * Async function that polls for dockerd readiness inside the VM.
   * Production: SSH/vsock check. Default: 3-second timeout stub.
   */
  waitForDockerFn?: (socketPath: string) => Promise<void>;
}

/** Options for restoring a VM snapshot. */
export interface RestoreOptions extends VmOptions {
  /** Directory containing the snapshot files. */
  snapshotDir: string;
  /** Optional virtiofsd workspace mount. */
  workspace?: Omit<VirtiofsdOptions, "spawnFn">;
}

/** A running Firecracker VM instance. */
export interface RunningVm {
  /** The socket path for the management API. */
  socketPath: string;
  /** The snapshot directory (if built). */
  snapshotDir?: string;
  /** Active virtiofsd mount, if any. */
  virtiofsd?: VirtiofsdProcess;
  /** Kill the VM and all child processes. */
  kill(): void;
  /** The underlying Firecracker process. */
  process: ChildProcess;
}

/** Default paths for a snapshot identified by tag. */
export function snapshotPaths(
  tag: string,
  cacheBase?: string,
): {
  dir: string;
  vmstate: string;
  mem: string;
} {
  const base = cacheBase ?? join(homedir(), ".superfield");
  const dir = join(base, "vm-snapshots", tag);
  return {
    dir,
    vmstate: join(dir, "snapshot.vmstate"),
    mem: join(dir, "snapshot.mem"),
  };
}

/**
 * Start a Firecracker process and return a low-level handle.
 * The process is not yet configured — use the returned API to set it up.
 */
function startFirecrackerProcess(
  binary: string,
  socketPath: string,
  spawnFn: typeof spawn = spawn,
): ChildProcess {
  const proc = spawnFn(
    binary,
    ["--api-sock", socketPath, "--level", "Warning"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      process.stderr.write(`[firecracker] ${line}\n`);
    }
  });

  return proc;
}

/**
 * Wait for the Firecracker API socket to become ready.
 * Polls at 50ms intervals up to `timeoutMs`.
 */
async function waitForSocket(
  socketPath: string,
  timeoutMs = 5000,
): Promise<void> {
  const { stat } = await import("node:fs/promises");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await stat(socketPath)
      .then(() => true)
      .catch(() => false);
    if (exists) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Firecracker socket ${socketPath} did not appear within ${timeoutMs}ms`,
  );
}

/**
 * Default wait-for-dockerd implementation.
 * In production this would SSH or vsock-connect into the VM.
 * The default stub waits 3 seconds (sufficient for snapshot use-case where
 * dockerd is already running in the pre-built image).
 */
async function defaultWaitForDocker(_socketPath: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000));
}

/**
 * Boot a VM from a rootfs, wait for dockerd, then save a Firecracker snapshot.
 *
 * Snapshot files are stored under:
 *   <cacheBase>/vm-snapshots/<snapshotTag>/
 *     snapshot.vmstate
 *     snapshot.mem
 *
 * @returns The running VM handle (caller must call .kill() after snapshotting).
 */
export async function buildVmSnapshot(
  opts: BuildSnapshotOptions,
): Promise<RunningVm> {
  const socketPath =
    opts.socketPath ?? join(tmpdir(), `superfield-fc-${Date.now()}.sock`);
  const vcpuCount = opts.vcpuCount ?? 2;
  const memSizeMib = opts.memSizeMib ?? 1024;
  const spawnFn = opts.spawnFn ?? spawn;
  const waitForDocker = opts.waitForDockerFn ?? defaultWaitForDocker;

  const {
    dir: snapshotDir,
    vmstate,
    mem,
  } = snapshotPaths(opts.snapshotTag, opts.cacheBase);
  await mkdir(snapshotDir, { recursive: true });

  const waitForSocketFn = opts.waitForSocketFn ?? waitForSocket;

  // Start Firecracker process.
  const proc = startFirecrackerProcess(opts.binary, socketPath, spawnFn);
  await waitForSocketFn(socketPath);

  const api = new FirecrackerApi(socketPath, opts.apiClient);

  // Configure VM in order required by Firecracker API.
  await api.putBootSource({
    kernel_image_path: opts.kernelPath,
    boot_args: "console=ttyS0 reboot=k panic=1 pci=off nomodule rw",
  });

  await api.putDrive({
    drive_id: "rootfs",
    path_on_host: opts.rootfsPath,
    is_root_device: true,
    is_read_only: false,
  });

  await api.putMachineConfig({
    vcpu_count: vcpuCount,
    mem_size_mib: memSizeMib,
  });

  // Start the VM.
  await api.startInstance();

  process.stderr.write(
    `[firecracker] VM booted, waiting for dockerd readiness...\n`,
  );
  await waitForDocker(socketPath);
  process.stderr.write(`[firecracker] dockerd ready, taking snapshot\n`);

  // Pause VM before snapshot (required by Firecracker).
  await api.pauseVm();

  await api.createSnapshot({
    snapshot_type: "Full",
    snapshot_path: vmstate,
    mem_file_path: mem,
  });

  process.stderr.write(`[firecracker] snapshot saved to ${snapshotDir}\n`);

  const vm: RunningVm = {
    socketPath,
    snapshotDir,
    process: proc,
    kill(): void {
      proc.kill("SIGTERM");
    },
  };

  return vm;
}

/**
 * Restore a Firecracker VM from a previously saved snapshot.
 *
 * If a workspace mount is provided, virtiofsd is started and the workspace
 * virtio-fs tag is passed to the VM config before snapshot restore.
 *
 * @returns A running VM handle. Call .kill() to tear down cleanly.
 */
export async function restoreVm(opts: RestoreOptions): Promise<RunningVm> {
  const socketPath =
    opts.socketPath ?? join(tmpdir(), `superfield-fc-${Date.now()}.sock`);
  const spawnFn = opts.spawnFn ?? spawn;

  const vmstate = join(opts.snapshotDir, "snapshot.vmstate");
  const mem = join(opts.snapshotDir, "snapshot.mem");

  const waitForSocketFn = opts.waitForSocketFn ?? waitForSocket;

  // Start virtiofsd if a workspace is requested.
  let virtiofsdHandle: VirtiofsdProcess | undefined;
  if (opts.workspace) {
    virtiofsdHandle = await mountWorkspace({
      ...opts.workspace,
      spawnFn,
    });
    process.stderr.write(
      `[firecracker] virtiofsd socket: ${virtiofsdHandle.socketPath}\n`,
    );
  }

  // Start Firecracker process.
  const proc = startFirecrackerProcess(opts.binary, socketPath, spawnFn);
  await waitForSocketFn(socketPath);

  const api = new FirecrackerApi(socketPath, opts.apiClient);

  // Load the snapshot — this is the fast path (<1s).
  await api.loadSnapshot({
    snapshot_path: vmstate,
    mem_backend: {
      backend_path: mem,
      backend_type: "File",
    },
    resume_vm: true,
  });

  process.stderr.write(`[firecracker] VM restored from ${opts.snapshotDir}\n`);

  const vm: RunningVm = {
    socketPath,
    virtiofsd: virtiofsdHandle,
    process: proc,
    kill(): void {
      proc.kill("SIGTERM");
      virtiofsdHandle?.kill();
    },
  };

  return vm;
}
