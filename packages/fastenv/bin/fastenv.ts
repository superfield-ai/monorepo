#!/usr/bin/env bun
/**
 * fastenv — OCI-native fast workspace forking CLI.
 *
 * Subcommands:
 *   build-base <image>                Pull and unpack base OCI image
 *   fork --base <image> --name <id>   Create a COW workspace fork
 *   exec <fork-id> -- <cmd...>        Run a command inside a fork
 *   du <fork-id>                      Show writable-layer disk usage
 *   diff <fork-id>                    List changed files in fork
 *   export-patch <fork-id> <out.tar>  Export writable layer as tar
 *   discard <fork-id>                 Delete a fork and reclaim disk
 *   list                              List all active forks
 *   gc [--ttl <ms>]                   GC forks older than TTL (default: 3600000ms)
 *   benchmark --image <img> [--forks <n>] [--concurrency <n>]
 *                                     Run latency and disk-usage benchmarks
 */

import {
  buildBase,
  forkWorkspace,
  execInFork,
  diskUsage,
  diffFork,
  exportPatch,
  discardFork,
  listForks,
  gcForks,
  runBenchmark,
  printBenchmarkResult,
} from "../index.ts";

const USAGE = `
fastenv — OCI-native fast workspace forking for AI agents

Commands:
  build-base <image>
    Pull and unpack an OCI image into the containerd content store.
    Creates the immutable base snapshot chain for COW forking.

  fork --base <image> --name <fork-id>
    Create a new workspace fork (writable overlayfs layer).
    Target: p50 ≤50ms, p95 ≤100ms.

  exec <fork-id> -- <cmd...>
    Execute a command inside the forked workspace.
    Runs in an isolated mount+PID namespace via containerd/crun.

  du <fork-id>
    Show writable-layer disk usage (COW delta only, excludes base).

  diff <fork-id>
    List files changed in the writable layer vs the base.

  export-patch <fork-id> <output.tar.gz>
    Export the writable layer as a compressed tar archive.

  discard <fork-id>
    Delete the fork and release its writable layer immediately.

  list
    List all active forks in the fastenv namespace.

  gc [--ttl <ms>]
    Garbage-collect forks older than TTL milliseconds (default: 3600000 = 1h).

  benchmark --image <image> [--forks <n>] [--concurrency <n>]
    Run the latency and concurrent-fork benchmark suite.

Environment:
  Requires containerd v2.2.1+ with overlayfs snapshotter.
  Socket: /run/containerd/containerd.sock
  Needs root or membership in the 'containerd' group.
`.trim();

function die(msg: string): never {
  console.error(`fastenv: ${msg}`);
  process.exit(1);
}

async function main(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    return;
  }

  switch (subcommand) {
    case "build-base": {
      const image = rest[0];
      if (!image) die("build-base requires <image>");
      console.log(`[fastenv] pulling and unpacking: ${image}`);
      await buildBase(image);
      console.log(`[fastenv] base ready: ${image}`);
      break;
    }

    case "fork": {
      let base: string | undefined;
      let name: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--base") base = rest[++i];
        else if (rest[i] === "--name") name = rest[++i];
        else if (rest[i]?.startsWith("--base=")) base = (rest[i] as string).slice(7);
        else if (rest[i]?.startsWith("--name=")) name = (rest[i] as string).slice(7);
      }
      if (!base) die("fork requires --base <image>");
      if (!name) die("fork requires --name <fork-id>");
      console.log(`[fastenv] forking ${base} → ${name}`);
      const result = await forkWorkspace(base, name);
      console.log(
        `[fastenv] fork created: ${result.forkId} in ${result.durationMs.toFixed(1)}ms`,
      );
      break;
    }

    case "exec": {
      const forkId = rest[0];
      if (!forkId) die("exec requires <fork-id>");
      const dashDash = rest.indexOf("--");
      const cmd = dashDash >= 0 ? rest.slice(dashDash + 1) : rest.slice(1);
      if (cmd.length === 0) die("exec requires a command after --");
      const { exitCode } = await execInFork(forkId, cmd);
      process.exit(exitCode);
      break;
    }

    case "du": {
      const forkId = rest[0];
      if (!forkId) die("du requires <fork-id>");
      const du = await diskUsage(forkId);
      const kb = (du.writableBytes / 1024).toFixed(1);
      console.log(`${forkId}\t${kb} KiB (writable layer only)`);
      break;
    }

    case "diff": {
      const forkId = rest[0];
      if (!forkId) die("diff requires <fork-id>");
      const files = await diffFork(forkId);
      if (files.length === 0) {
        console.log(`[fastenv] no changes in fork: ${forkId}`);
      } else {
        files.forEach((f) => console.log(f));
      }
      break;
    }

    case "export-patch": {
      const forkId = rest[0];
      const outputPath = rest[1];
      if (!forkId) die("export-patch requires <fork-id>");
      if (!outputPath) die("export-patch requires <output.tar.gz>");
      await exportPatch(forkId, outputPath);
      console.log(`[fastenv] exported patch: ${outputPath}`);
      break;
    }

    case "discard": {
      const forkId = rest[0];
      if (!forkId) die("discard requires <fork-id>");
      await discardFork(forkId);
      console.log(`[fastenv] discarded: ${forkId}`);
      break;
    }

    case "list": {
      const forks = await listForks();
      if (forks.length === 0) {
        console.log("[fastenv] no active forks");
      } else {
        forks.forEach((id) => console.log(id));
      }
      break;
    }

    case "gc": {
      let ttlMs = 3_600_000; // 1 hour default
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--ttl" && rest[i + 1])
          ttlMs = parseInt(rest[++i] ?? "0", 10);
        else if (rest[i]?.startsWith("--ttl="))
          ttlMs = parseInt((rest[i] as string).slice(6), 10);
      }
      console.log(`[fastenv] running GC (TTL: ${ttlMs}ms)`);
      const discarded = await gcForks(ttlMs);
      console.log(
        `[fastenv] GC complete — discarded ${discarded.length} forks`,
      );
      discarded.forEach((id) => console.log(`  - ${id}`));
      break;
    }

    case "benchmark": {
      let image: string | undefined;
      let forks: number | undefined;
      let concurrency: number | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--image") image = rest[++i];
        else if (rest[i]?.startsWith("--image=")) image = (rest[i] as string).slice(8);
        else if (rest[i] === "--forks") forks = parseInt(rest[++i] ?? "20", 10);
        else if (rest[i]?.startsWith("--forks="))
          forks = parseInt((rest[i] as string).slice(8), 10);
        else if (rest[i] === "--concurrency")
          concurrency = parseInt(rest[++i] ?? "10", 10);
        else if (rest[i]?.startsWith("--concurrency="))
          concurrency = parseInt((rest[i] as string).slice(14), 10);
      }
      if (!image) die("benchmark requires --image <image>");
      console.log("[fastenv] starting benchmark suite");
      const result = await runBenchmark({ image, forks, concurrency });
      printBenchmarkResult(result);
      // Exit non-zero if p95 exceeds 100ms target.
      if (result.latency.p95Ms > 100) {
        console.error(
          `[fastenv] FAIL: p95 ${result.latency.p95Ms.toFixed(1)}ms exceeds 100ms target`,
        );
        process.exit(1);
      }
      break;
    }

    default:
      die(`unknown subcommand: ${subcommand}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(
    `[fastenv] error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
