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
 *
 * Usage:
 *   import { provisionFirecracker, buildVmSnapshot, restoreVm } from "@superfield/firecracker";
 *
 * Requires:
 *   - /dev/kvm (KVM-capable host, confirmed present on self-hosted runner)
 *   - Firecracker binary (downloaded automatically by provisionFirecracker)
 *   - virtiofsd binary (must be provisioned separately; see VIRTIOFSD_PATH env)
 *
 * See: docs/scout/281-oci-firecracker-toolchain.md
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
