/**
 * Benchmark suite for fastenv workspace forking.
 *
 * Measures:
 *   - Fork creation latency (p50, p95)
 *   - Disk usage per fork (writable layer only)
 *   - Max concurrent forks sustainable within a disk budget
 *
 * Run with: fastenv benchmark --image <image> [--forks <n>] [--concurrency <n>]
 */

import { forkWorkspace, discardFork, diskUsage } from "./snapshotter.ts";

export interface BenchmarkOptions {
  image: string;
  /** Number of sequential fork/discard cycles for latency percentiles. */
  forks?: number;
  /** Number of concurrent forks for the concurrent-fork test. */
  concurrency?: number;
}

export interface LatencyStats {
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  samples: number;
}

export interface BenchmarkResult {
  image: string;
  latency: LatencyStats;
  /** Writable layer bytes for one idle fork (no writes). */
  baseWritableBytes: number;
  /** Number of concurrent forks that completed without error. */
  concurrentForks: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * Run the full benchmark suite.
 * Precondition: the base image must already be unpacked (`fastenv build-base`).
 */
export async function runBenchmark(
  opts: BenchmarkOptions
): Promise<BenchmarkResult> {
  const forkCount = opts.forks ?? 20;
  const concurrency = opts.concurrency ?? 10;
  const latencies: number[] = [];

  // --- Sequential latency measurement ---
  console.log(`[bench] sequential fork latency: ${forkCount} iterations`);
  for (let i = 0; i < forkCount; i++) {
    const id = `bench-seq-${Date.now()}-${i}`;
    const result = await forkWorkspace(opts.image, id);
    latencies.push(result.durationMs);
    await discardFork(id);
    process.stdout.write(
      `\r  ${i + 1}/${forkCount} — last: ${result.durationMs.toFixed(1)}ms`
    );
  }
  console.log();

  const sorted = [...latencies].sort((a, b) => a - b);
  const latency: LatencyStats = {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    samples: sorted.length,
  };

  // --- Writable layer baseline ---
  console.log("[bench] measuring idle writable layer size");
  const baseId = `bench-base-${Date.now()}`;
  await forkWorkspace(opts.image, baseId);
  const du = await diskUsage(baseId);
  await discardFork(baseId);

  // --- Concurrent fork test ---
  console.log(`[bench] concurrent fork test: ${concurrency} parallel forks`);
  const concIds = Array.from(
    { length: concurrency },
    (_, i) => `bench-conc-${Date.now()}-${i}`
  );
  const results = await Promise.allSettled(
    concIds.map((id) => forkWorkspace(opts.image, id))
  );
  const succeeded = results.filter((r) => r.status === "fulfilled").length;

  // Cleanup concurrent forks.
  await Promise.allSettled(concIds.map((id) => discardFork(id)));

  return {
    image: opts.image,
    latency,
    baseWritableBytes: du.writableBytes,
    concurrentForks: succeeded,
  };
}

export function printBenchmarkResult(result: BenchmarkResult): void {
  console.log("\n=== fastenv benchmark results ===");
  console.log(`Image:              ${result.image}`);
  console.log(
    `Fork latency p50:   ${result.latency.p50Ms.toFixed(1)}ms ${result.latency.p50Ms <= 50 ? "✓" : "✗ (target ≤50ms)"}`
  );
  console.log(
    `Fork latency p95:   ${result.latency.p95Ms.toFixed(1)}ms ${result.latency.p95Ms <= 100 ? "✓" : "✗ (target ≤100ms)"}`
  );
  console.log(
    `Fork latency min:   ${result.latency.minMs.toFixed(1)}ms`
  );
  console.log(
    `Fork latency max:   ${result.latency.maxMs.toFixed(1)}ms`
  );
  console.log(`Samples:            ${result.latency.samples}`);
  console.log(
    `Idle writable size: ${(result.baseWritableBytes / 1024).toFixed(1)} KiB (COW delta only)`
  );
  console.log(
    `Concurrent forks:   ${result.concurrentForks} completed without error`
  );
  console.log("");
}
