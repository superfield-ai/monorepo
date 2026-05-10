/**
 * @superfield/fastenv — OCI-native fast workspace forking for AI agents.
 *
 * Uses containerd overlayfs snapshotter to fork isolated workspaces in ≤100ms p95.
 * No file copying. COW semantics via kernel overlayfs upperdir.
 *
 * Requires: containerd v2.2.1+, overlayfs snapshotter active.
 * Socket: /run/containerd/containerd.sock (needs root or `containerd` group).
 */

export {
  buildBase,
  forkWorkspace,
  execInFork,
  diskUsage,
  diffFork,
  exportPatch,
  discardFork,
  listForks,
  gcForks,
  SNAPSHOTTER,
  NAMESPACE,
  CONTAINERD_SOCKET,
} from "./snapshotter.ts";

export type { SnapshotInfo, ForkResult, DiskUsage } from "./snapshotter.ts";

export { runBenchmark, printBenchmarkResult } from "./benchmark.ts";

export type {
  BenchmarkOptions,
  BenchmarkResult,
  LatencyStats,
} from "./benchmark.ts";
