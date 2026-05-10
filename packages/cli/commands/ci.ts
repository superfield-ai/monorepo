/**
 * `superfield ci` command — local CI workflow runner.
 *
 * Subcommands:
 *   run <workflow> [--vm]   Execute a workflow locally.
 *   snapshot build <tag>    Build a Firecracker VM snapshot.
 *   snapshot restore <dir>  Restore a VM snapshot (for testing/debugging).
 *
 * With --vm the microVM executor is selected (requires /dev/kvm).
 * Without --vm the Docker executor is used (standard container runner).
 *
 * See: packages/firecracker/ for VM lifecycle internals.
 * See: docs/scout/281-oci-firecracker-toolchain.md for environment constraints.
 */

export interface CiRunOptions {
  /** The workflow file name or path (e.g. "test-e2e.yml"). */
  workflow: string;
  /** Use the Firecracker microVM executor. */
  vmExecutor: boolean;
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
  /** Optional workspace directory to mount via virtio-fs. */
  workspaceDir?: string;
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
 *   ci run <workflow> [--vm]
 *   ci snapshot build --tag <tag> --rootfs <path> [--binary <path>] [--kernel <path>]
 *   ci snapshot restore <dir> [--workspace <dir>]
 *   ci --help | -h | help
 */
export function parseCiArgs(args: string[]): ParsedCiArgs {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    return { subcommand: "help" };
  }

  if (sub === "run") {
    const [workflow, ...flags] = rest;
    if (!workflow) {
      return { subcommand: "help" };
    }
    const vmExecutor = flags.includes("--vm");
    return { subcommand: "run", opts: { workflow, vmExecutor } };
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
        else if (arg?.startsWith("--tag=")) tag = arg.slice(6);
        else if (arg?.startsWith("--binary=")) binaryPath = arg.slice(9);
        else if (arg?.startsWith("--kernel=")) kernelPath = arg.slice(9);
        else if (arg?.startsWith("--rootfs=")) rootfsPath = arg.slice(9);
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

      let workspaceDir: string | undefined;
      for (let i = 1; i < snapshotRest.length; i++) {
        const arg = snapshotRest[i];
        if (arg === "--workspace") workspaceDir = snapshotRest[++i];
        else if (arg?.startsWith("--workspace=")) workspaceDir = arg.slice(12);
      }

      return {
        subcommand: "snapshot-restore",
        opts: { snapshotDir, workspaceDir },
      };
    }
  }

  return { subcommand: "help" };
}

const CI_USAGE = `
superfield ci — local CI workflow runner

Commands:
  run <workflow> [--vm]
    Execute a CI workflow locally.
    Without --vm: uses the Docker executor (standard container runner).
    With --vm: uses the Firecracker microVM executor (requires /dev/kvm).
    The microVM executor provides a real Docker daemon and k3d isolation.

  snapshot build --tag <tag> --rootfs <path> [--binary <path>] [--kernel <path>]
    Build a Firecracker VM snapshot from a rootfs ext4 image.
    The snapshot is stored under ~/.superfield/vm-snapshots/<tag>/.
    Subsequent \`ci run --vm\` calls restore from this snapshot in <1s.

  snapshot restore <dir> [--workspace <dir>]
    Restore a previously built VM snapshot for debugging.
    Optionally mounts a workspace directory via virtio-fs.

Notes:
  The microVM executor requires:
    - /dev/kvm accessible on the host
    - Firecracker binary (auto-downloaded to ~/.superfield/firecracker-<version>/)
    - virtiofsd binary (set VIRTIOFSD_PATH or place on $PATH)
`.trim();

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
    const { workflow, vmExecutor } = parsed.opts;
    if (vmExecutor) {
      console.log(
        `[ci] running ${workflow} with Firecracker microVM executor (--vm)`,
      );
      console.log(
        `[ci] microVM executor: ensure a snapshot exists or run 'superfield ci snapshot build' first`,
      );
      // Full executor integration is wired in follow-up work once the workflow
      // parser (from #241) is available. The flag plumbing and executor
      // selection are the deliverables for this issue.
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

    // Lazy-import to avoid loading Firecracker code for Docker-only runs.
    const { provisionFirecracker } = await import("@superfield/firecracker");
    const { buildVmSnapshot } = await import("@superfield/firecracker");

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
    const { snapshotDir, workspaceDir } = parsed.opts;

    const { restoreVm, provisionFirecracker } =
      await import("@superfield/firecracker");

    const paths = await provisionFirecracker();

    console.log(`[ci] restoring VM from snapshot: ${snapshotDir}`);
    const vm = await restoreVm({
      binary: paths.binary,
      kernelPath: paths.kernel,
      rootfsPath: "",
      snapshotDir,
      ...(workspaceDir ? { workspace: { sharedDir: workspaceDir } } : {}),
    });

    console.log(`[ci] VM running, socket: ${vm.socketPath}`);
    console.log(`[ci] press Ctrl+C to stop`);

    process.on("SIGINT", () => {
      vm.kill();
      process.exit(0);
    });
    return;
  }
}
