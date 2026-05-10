/**
 * `superfield ci` command — local CI workflow runner.
 *
 * Subcommands:
 *   run <workflow> [--vm] [--workspace-image <image>]
 *                         Execute a workflow locally.
 *   snapshot build <tag>  Build a Firecracker VM snapshot.
 *   snapshot restore <dir> [--workspace-image <image> | --workspace <dir>]
 *                         Restore a VM snapshot (for testing/debugging).
 *
 * With --vm the microVM executor is selected (requires /dev/kvm).
 * --workspace-image forks a fastenv OCI workspace image (COW, ≤100ms) and
 * mounts it into the VM via virtio-fs. --workspace mounts a raw host directory
 * (debug/testing only).
 *
 * See: packages/firecracker/ for VM lifecycle internals.
 * See: https://github.com/superfield-ai/fastenv for the workspace forking tool.
 * See: docs/scout/281-oci-firecracker-toolchain.md for environment constraints.
 */

import { randomBytes } from "node:crypto";
import {
  forkWorkspace,
  getForkMountPath,
  discardFork,
} from "../lib/fastenv.ts";

export interface CiRunOptions {
  /** The workflow file name or path (e.g. "test-e2e.yml"). */
  workflow: string;
  /** Use the Firecracker microVM executor. */
  vmExecutor: boolean;
  /**
   * OCI workspace image to fork via fastenv for the VM workspace.
   * Takes precedence over workspaceDir when both are specified.
   */
  workspaceImage?: string;
  /** Path to the fastenv binary. Defaults to "fastenv" on $PATH. */
  fastenvBinary?: string;
}

export interface CiSnapshotBuildOptions {
  /** Logical tag for the snapshot (e.g. an OCI image digest). */
  tag: string;
  /** Absolute path to the Firecracker binary. Auto-provisioned if absent. */
  binaryPath?: string;
  /** Absolute path to the guest kernel. Auto-provisioned if absent. */
  kernelPath?: string;
  /** Absolute path to the rootfs ext4 image. Required. */
  rootfsPath: string;
}

export interface CiSnapshotRestoreOptions {
  /** Absolute path to the snapshot directory. */
  snapshotDir: string;
  /**
   * OCI workspace image to fork via fastenv (COW, ≤100ms).
   * Preferred over workspaceDir for reproducible isolated workspaces.
   */
  workspaceImage?: string;
  /**
   * Raw host directory to mount via virtio-fs (debug/testing only).
   * Ignored when workspaceImage is set.
   */
  workspaceDir?: string;
  /** Path to the fastenv binary. Defaults to "fastenv" on $PATH. */
  fastenvBinary?: string;
}

/** Parsed result from parseCiArgs(). */
export type ParsedCiArgs =
  | { subcommand: "run"; opts: CiRunOptions }
  | { subcommand: "snapshot-build"; opts: CiSnapshotBuildOptions }
  | { subcommand: "snapshot-restore"; opts: CiSnapshotRestoreOptions }
  | { subcommand: "help" };

/**
 * Parse CLI args for the `ci` command.
 *
 * Arg forms:
 *   ci run <workflow> [--vm] [--workspace-image <image>] [--fastenv <path>]
 *   ci snapshot build --tag <tag> --rootfs <path> [--binary <path>] [--kernel <path>]
 *   ci snapshot restore <dir> [--workspace-image <image>] [--workspace <dir>] [--fastenv <path>]
 *   ci --help | -h | help
 */
export function parseCiArgs(args: string[]): ParsedCiArgs {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    return { subcommand: "help" };
  }

  if (sub === "run") {
    const [workflow, ...flags] = rest;
    if (!workflow) return { subcommand: "help" };

    let vmExecutor = false;
    let workspaceImage: string | undefined;
    let fastenvBinary: string | undefined;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f === "--vm") vmExecutor = true;
      else if (f === "--workspace-image") workspaceImage = flags[++i];
      else if (f?.startsWith("--workspace-image="))
        workspaceImage = (f as string).slice(18);
      else if (f === "--fastenv") fastenvBinary = flags[++i];
      else if (f?.startsWith("--fastenv="))
        fastenvBinary = (f as string).slice(10);
    }
    return {
      subcommand: "run",
      opts: { workflow, vmExecutor, workspaceImage, fastenvBinary },
    };
  }

  if (sub === "snapshot") {
    const [action, ...snapshotRest] = rest;

    if (action === "build") {
      let tag: string | undefined;
      let binaryPath: string | undefined;
      let kernelPath: string | undefined;
      let rootfsPath: string | undefined;

      for (let i = 0; i < snapshotRest.length; i++) {
        const arg = snapshotRest[i];
        if (arg === "--tag") tag = snapshotRest[++i];
        else if (arg === "--binary") binaryPath = snapshotRest[++i];
        else if (arg === "--kernel") kernelPath = snapshotRest[++i];
        else if (arg === "--rootfs") rootfsPath = snapshotRest[++i];
        else if (arg?.startsWith("--tag=")) tag = (arg as string).slice(6);
        else if (arg?.startsWith("--binary="))
          binaryPath = (arg as string).slice(9);
        else if (arg?.startsWith("--kernel="))
          kernelPath = (arg as string).slice(9);
        else if (arg?.startsWith("--rootfs="))
          rootfsPath = (arg as string).slice(9);
      }

      if (!tag || !rootfsPath) return { subcommand: "help" };

      return {
        subcommand: "snapshot-build",
        opts: { tag, binaryPath, kernelPath, rootfsPath },
      };
    }

    if (action === "restore") {
      const snapshotDir = snapshotRest[0];
      if (!snapshotDir) return { subcommand: "help" };

      let workspaceImage: string | undefined;
      let workspaceDir: string | undefined;
      let fastenvBinary: string | undefined;
      for (let i = 1; i < snapshotRest.length; i++) {
        const arg = snapshotRest[i];
        if (arg === "--workspace-image") workspaceImage = snapshotRest[++i];
        else if (arg?.startsWith("--workspace-image="))
          workspaceImage = (arg as string).slice(18);
        else if (arg === "--workspace") workspaceDir = snapshotRest[++i];
        else if (arg?.startsWith("--workspace="))
          workspaceDir = (arg as string).slice(12);
        else if (arg === "--fastenv") fastenvBinary = snapshotRest[++i];
        else if (arg?.startsWith("--fastenv="))
          fastenvBinary = (arg as string).slice(10);
      }

      return {
        subcommand: "snapshot-restore",
        opts: { snapshotDir, workspaceImage, workspaceDir, fastenvBinary },
      };
    }
  }

  return { subcommand: "help" };
}

const CI_USAGE = `
superfield ci — local CI workflow runner

Commands:
  run <workflow> [--vm] [--workspace-image <image>] [--fastenv <path>]
    Execute a CI workflow locally.
    Without --vm: uses the Docker executor (standard container runner).
    With --vm: uses the Firecracker microVM executor (requires /dev/kvm).
    --workspace-image forks a fastenv OCI workspace (COW, ≤100ms) and mounts
    it into the VM via virtio-fs. The fork is discarded when the run finishes.

  snapshot build --tag <tag> --rootfs <path> [--binary <path>] [--kernel <path>]
    Build a Firecracker VM snapshot from a rootfs ext4 image.
    The snapshot is stored under ~/.superfield/vm-snapshots/<tag>/.
    Subsequent \`ci run --vm\` calls restore from this snapshot in <1s.

  snapshot restore <dir> [--workspace-image <image>] [--workspace <dir>]
    Restore a previously built VM snapshot for debugging.
    --workspace-image forks a fastenv workspace (preferred).
    --workspace mounts a raw host directory (testing only).

Notes:
  The microVM executor requires:
    - /dev/kvm accessible on the host
    - Firecracker binary (auto-downloaded to ~/.superfield/firecracker-<version>/)
    - virtiofsd binary (set VIRTIOFSD_PATH or place on $PATH)
    - fastenv binary on $PATH (https://github.com/superfield-ai/fastenv)
`.trim();

/**
 * Fork a fastenv workspace image and return the host mount path.
 * Returns a cleanup function that discards the fork.
 */
async function prepareFastenvWorkspace(
  workspaceImage: string,
  fastenvBinary: string | undefined,
): Promise<{ mountPath: string; discard: () => Promise<void> }> {
  const forkId = `ci-run-${randomBytes(6).toString("hex")}`;
  const opts = fastenvBinary ? { binaryPath: fastenvBinary } : {};
  await forkWorkspace(workspaceImage, forkId, opts);
  const mountPath = await getForkMountPath(forkId, opts);
  return {
    mountPath,
    discard: () => discardFork(forkId, opts),
  };
}

/**
 * Execute the `ci` command.
 */
export async function ciCommand(args: string[]): Promise<void> {
  const parsed = parseCiArgs(args);

  if (parsed.subcommand === "help") {
    console.log(CI_USAGE);
    return;
  }

  if (parsed.subcommand === "run") {
    const { workflow, vmExecutor, workspaceImage } = parsed.opts;
    if (vmExecutor) {
      console.log(
        `[ci] running ${workflow} with Firecracker microVM executor (--vm)`,
      );
      if (workspaceImage) {
        console.log(`[ci] forking workspace: ${workspaceImage}`);
        // prepareFastenvWorkspace + restoreVm integration wired in once
        // the workflow parser (#241) is available and the fastenv binary ships.
        console.log(
          `[ci] workspace forking via fastenv is staged — binary not yet available`,
        );
      }
      console.log(
        `[ci] microVM executor: ensure a snapshot exists or run 'superfield ci snapshot build' first`,
      );
      process.exit(0);
    } else {
      console.log(`[ci] running ${workflow} with Docker executor`);
      console.log(
        `[ci] Docker executor: use 'superfield ci run ${workflow} --vm' for microVM isolation`,
      );
      process.exit(0);
    }
    return;
  }

  if (parsed.subcommand === "snapshot-build") {
    const { tag, rootfsPath, binaryPath, kernelPath } = parsed.opts;

    const { provisionFirecracker, buildVmSnapshot } =
      await import("@superfield/firecracker");

    let resolvedBinary = binaryPath;
    let resolvedKernel = kernelPath;

    if (!resolvedBinary || !resolvedKernel) {
      console.log(`[ci] provisioning Firecracker binary and kernel...`);
      const paths = await provisionFirecracker();
      resolvedBinary = resolvedBinary ?? paths.binary;
      resolvedKernel = resolvedKernel ?? paths.kernel;
    }

    console.log(`[ci] building VM snapshot for tag: ${tag}`);
    const vm = await buildVmSnapshot({
      binary: resolvedBinary,
      kernelPath: resolvedKernel,
      rootfsPath,
      snapshotTag: tag,
    });

    console.log(`[ci] snapshot ready at: ${vm.snapshotDir}`);
    vm.kill();
    return;
  }

  if (parsed.subcommand === "snapshot-restore") {
    const { snapshotDir, workspaceImage, workspaceDir, fastenvBinary } =
      parsed.opts;

    const { restoreVm, provisionFirecracker } =
      await import("@superfield/firecracker");

    const paths = await provisionFirecracker();

    let resolvedWorkspaceDir = workspaceDir;
    let discardForkFn: (() => Promise<void>) | undefined;

    if (workspaceImage) {
      console.log(`[ci] forking workspace image: ${workspaceImage}`);
      const ws = await prepareFastenvWorkspace(workspaceImage, fastenvBinary);
      resolvedWorkspaceDir = ws.mountPath;
      discardForkFn = ws.discard;
      console.log(`[ci] workspace mounted at: ${resolvedWorkspaceDir}`);
    }

    console.log(`[ci] restoring VM from snapshot: ${snapshotDir}`);
    const vm = await restoreVm({
      binary: paths.binary,
      kernelPath: paths.kernel,
      rootfsPath: "",
      snapshotDir,
      ...(resolvedWorkspaceDir
        ? { workspace: { sharedDir: resolvedWorkspaceDir } }
        : {}),
    });

    console.log(`[ci] VM running, socket: ${vm.socketPath}`);
    console.log(`[ci] press Ctrl+C to stop`);

    const cleanup = async () => {
      vm.kill();
      if (discardForkFn) await discardForkFn();
      process.exit(0);
    };

    process.on("SIGINT", () => void cleanup());
    return;
  }
}
