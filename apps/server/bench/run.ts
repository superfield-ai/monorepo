/**
 * Sharp performance bench suite entry point.
 *
 * Starts a PostgreSQL container, runs all bench suites in sequence, and
 * reports results to console (and optionally writes JSON to a file).
 *
 * Usage:
 *   bun apps/server/bench/run.ts
 *   bun apps/server/bench/run.ts --json bench-report.json
 *
 * Threshold violations print WARN but exit 0 — the bench never hard-fails.
 */
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { startPostgres } from '../../../tests/harness/pg-container';
import { runMigrations } from '../src/migrate';
import { runCommitThroughput, type CommitThroughputResult } from './commit-throughput';
import { runEpisodeIngest, type EpisodeIngestResult } from './episode-ingest';
import { runCheckoutThroughput, type CheckoutThroughputResult } from './checkout-throughput';

// Required to bypass the SHA-1DC stub at startup.
process.env.SHARP_ALLOW_RAW_SHA1 = '1';

type SuiteResult = CommitThroughputResult | EpisodeIngestResult | CheckoutThroughputResult;

interface BenchReport {
  timestamp: string;
  results: SuiteResult[];
  warnings: string[];
}

function parseArgs(): { jsonPath: string | undefined } {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf('--json');
  return { jsonPath: jsonIdx >= 0 ? args[jsonIdx + 1] : undefined };
}

function printResult(result: SuiteResult): void {
  const status = result.pass ? 'PASS' : 'WARN';
  console.log(`\n  [${status}] ${result.suite}`);

  switch (result.suite) {
    case 'commit-throughput':
      console.log(`    commits : ${result.commitCount}`);
      console.log(`    p50     : ${result.p50ms} ms`);
      console.log(`    p95     : ${result.p95ms} ms`);
      console.log(`    p99     : ${result.p99ms} ms  (threshold: < ${result.thresholdP99Ms} ms)`);
      break;
    case 'episode-ingest':
      console.log(`    episodes     : ${result.episodeCount}`);
      console.log(`    total time   : ${result.totalMs} ms`);
      console.log(
        `    throughput   : ${result.episodesPerSec} eps  (threshold: > ${result.thresholdEpisodesPerSec} eps)`,
      );
      break;
    case 'checkout-throughput':
      console.log(`    files        : ${result.fileCount}`);
      console.log(
        `    checkout     : ${result.checkoutMs} ms  (threshold: < ${result.thresholdMs} ms)`,
      );
      break;
  }
}

async function main(): Promise<void> {
  const { jsonPath } = parseArgs();

  console.log('Sharp performance bench suite');
  console.log('Starting PostgreSQL container...');

  const container = await startPostgres();
  console.log(`  container: ${container.containerId.slice(0, 12)}`);

  const sql = postgres(container.url, { onnotice: () => {} });

  try {
    console.log('Running migrations...');
    await runMigrations(sql);

    const results: SuiteResult[] = [];
    const warnings: string[] = [];

    // ---- commit-throughput ----
    console.log('\nRunning commit-throughput...');
    const commitResult = await runCommitThroughput(sql);
    results.push(commitResult);
    printResult(commitResult);
    if (!commitResult.pass) {
      const msg = `commit-throughput: p99 ${commitResult.p99ms} ms >= threshold ${commitResult.thresholdP99Ms} ms`;
      warnings.push(msg);
      console.warn(`  WARN: ${msg}`);
    }

    // ---- episode-ingest ----
    console.log('\nRunning episode-ingest...');
    const episodeResult = await runEpisodeIngest(sql);
    results.push(episodeResult);
    printResult(episodeResult);
    if (!episodeResult.pass) {
      const msg = `episode-ingest: ${episodeResult.episodesPerSec} eps < threshold ${episodeResult.thresholdEpisodesPerSec} eps`;
      warnings.push(msg);
      console.warn(`  WARN: ${msg}`);
    }

    // ---- checkout-throughput ----
    console.log('\nRunning checkout-throughput...');
    const checkoutResult = await runCheckoutThroughput(sql);
    results.push(checkoutResult);
    printResult(checkoutResult);
    if (!checkoutResult.pass) {
      const msg = `checkout-throughput: ${checkoutResult.checkoutMs} ms >= threshold ${checkoutResult.thresholdMs} ms`;
      warnings.push(msg);
      console.warn(`  WARN: ${msg}`);
    }

    // ---- summary ----
    const report: BenchReport = {
      timestamp: new Date().toISOString(),
      results,
      warnings,
    };

    console.log('\n----------------------------------------');
    const passCount = results.filter((r) => r.pass).length;
    console.log(`Results: ${passCount}/${results.length} suites within thresholds`);
    if (warnings.length > 0) {
      console.log(`Warnings (${warnings.length}):`);
      for (const w of warnings) console.log(`  - ${w}`);
    }

    if (jsonPath) {
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
      console.log(`\nReport written to: ${jsonPath}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
    await container.stop();
    console.log('\nPostgreSQL container stopped.');
  }
}

main().catch((err) => {
  console.error('Bench suite failed:', err);
  process.exit(1);
});
