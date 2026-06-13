/**
 * @superfield/firecracker — Firecracker microVM CI runner.
 *
 * Provides snapshot-based fast-start microVMs for running CI workflows that
 * require a real Docker daemon and k3d (nested container orchestration).
 *
 * Key components:
 *   - provision.ts  — Firecracker binary + guest kernel download/cache
 *   - api.ts        — Firecracker management API client (Unix socket HTTP)
 *   - virtiofsd.ts  — virtiofsd host-guest filesystem bridge
 *   - vm.ts         — VM lifecycle: boot, snapshot, restore, kill
 *   - ebpf.ts       — host-side eBPF monitoring interface (issue #384)
 *
 * Usage:
 *   import { provisionFirecracker, buildVmSnapshot, restoreVm } from "@superfield/firecracker";
 *   import { attachEbpf, detachEbpf } from "@superfield/firecracker";
 *
 * Requires:
 *   - /dev/kvm (KVM-capable host, confirmed present on self-hosted runner)
 *   - Firecracker binary (downloaded automatically by provisionFirecracker)
 *   - virtiofsd binary (must be provisioned separately; see VIRTIOFSD_PATH env)
 *   - fastenv binary with `ebpf` subcommand (for eBPF attach/detach)
 *
 * See: crates/fastenv/docs/scout/firecracker-prerequisites.md
 *
 * Host-side eBPF monitoring (#384): the `attachEbpf` / `detachEbpf` functions
 * in `ebpf.ts` define the TypeScript surface for wiring host-kernel BPF
 * programs at the Firecracker/jailer boundary. The actual BPF program loading
 * runs inside the `fastenv` binary (`src/host_ebpf.rs`).
 *
 * crun promotion (#384): agent containers run under real crun via the
 * `CrunBackend` in the fastenv binary (`src/container_runtime.rs`). The CLI
 * `exec` subcommand accepts `--crun-path` to override the binary path.
 *
 * @see docs/architecture.md §Substrate Reliability
 */

export {
  provisionFirecracker,
  FIRECRACKER_VERSION,
  FIRECRACKER_ARCH,
} from "./provision.ts";

export type { FirecrackerPaths, ProvisionOptions } from "./provision.ts";

export { FirecrackerApi, defaultApiClient } from "./api.ts";

export type {
  ApiClient,
  MachineConfig,
  BootSource,
  Drive,
  VirtioFsConfig,
  NetworkInterface,
  SnapshotSaveRequest,
  SnapshotLoadRequest,
} from "./api.ts";

export { mountWorkspace, findVirtiofsdBinary } from "./virtiofsd.ts";

export type { VirtiofsdOptions, VirtiofsdProcess } from "./virtiofsd.ts";

export { buildVmSnapshot, restoreVm, snapshotPaths } from "./vm.ts";

export type {
  VmOptions,
  BuildSnapshotOptions,
  RestoreOptions,
  RunningVm,
} from "./vm.ts";

export { attachEbpf, detachEbpf, parseAttachOutput } from "./ebpf.ts";

export type {
  EbpfMonitorOptions,
  EbpfAttachResult,
  EbpfPolicySpec,
} from "./ebpf.ts";

/**
 * Stub: multi-host scheduling seam — not yet implemented (federated compute
 * is deferred per architecture decision 2026-05-30).
 *
 * Today the control plane is entirely single-host (Unix-socket per process).
 * This interface marks the integration boundary for the federated scheduler.
 *
 * @see docs/architecture.md §Substrate Reliability
 */
export interface HostScheduler {
  readonly implemented: false;
}
