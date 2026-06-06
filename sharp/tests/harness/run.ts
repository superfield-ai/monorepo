/**
 * Differential test harness entrypoint.
 *
 * Loads scenarios, runs both lanes per scenario inside an isolated tmpdir,
 * classifies the results, and emits a contingency-table report. Exits
 * non-zero iff any scenario's `expected_sharp_outcome` is missed.
 *
 * Usage:
 *   bun tests/harness/run.ts                       # full corpus, both lanes
 *   bun tests/harness/run.ts --filter refactor     # subset by glob
 *   bun tests/harness/run.ts --only-git            # skip the Sharp lane
 *   bun tests/harness/run.ts --only-sharp          # skip the git lane
 *   bun tests/harness/run.ts --json out.json       # write JSON report
 *   bun tests/harness/run.ts --keep-failures       # leave tmpdirs in place on failure
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadAllScenarios, SCENARIOS_ROOT } from './fixture/loader';
import { runGitLane } from './lanes/git';
import { runSharpLane, teardownSharpLane } from './lanes/sharp';
import { dockerAvailable, startPostgres, type PgContainer } from './pg-container';
import { startServer, type ServerHandle } from '../../apps/server/src/server';
import { issueToken } from '../../apps/server/src/auth';
import { SharpClient } from '../../apps/client/src';
import { classify, pass } from './classify';
import {
  printContingency,
  printScenarioLine,
  printSummary,
  writeFailureArtifacts,
  writeJsonReport,
} from './report';
import { withScenarioTmpdir } from './isolation/tmpdir';
import type { LaneResult, RunResult, Scenario, ScenarioResult } from './types';

/**
 * Failure artifacts are written under a per-run directory inside $TMPDIR.
 * The path is printed at the end of any failing run so a developer can
 * inspect the merged trees, but nothing is ever written into the repo.
 */
async function makeFailuresRoot(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), 'sharp-failures-'));
}

interface CliFlags {
  filter?: string;
  onlyGit: boolean;
  onlySharp: boolean;
  jsonPath?: string;
  keepFailures: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { onlyGit: false, onlySharp: false, keepFailures: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--filter':
        flags.filter = argv[++i];
        break;
      case '--only-git':
        flags.onlyGit = true;
        break;
      case '--only-sharp':
        flags.onlySharp = true;
        break;
      case '--json':
        flags.jsonPath = argv[++i];
        break;
      case '--keep-failures':
        flags.keepFailures = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(usage());
        process.exit(0);
        break;
      default:
        process.stderr.write(`unknown flag: ${arg}\n${usage()}`);
        process.exit(2);
    }
  }
  if (flags.onlyGit && flags.onlySharp) {
    process.stderr.write('--only-git and --only-sharp are mutually exclusive\n');
    process.exit(2);
  }
  return flags;
}

function usage(): string {
  return [
    'Sharp differential test harness',
    '',
    'Usage: bun tests/harness/run.ts [options]',
    '',
    'Options:',
    '  --filter <substr>   Run only scenarios whose id contains <substr>',
    '  --only-git          Skip the Sharp lane',
    '  --only-sharp        Skip the git lane',
    '  --json <path>       Write a machine-readable JSON report',
    '  --keep-failures     Leave per-scenario tmpdirs on disk on failure',
    '  -h, --help          Show this help',
    '',
  ].join('\n');
}

function matchesFilter(scenario: Scenario, filter?: string): boolean {
  if (!filter) return true;
  return scenario.id.includes(filter);
}

interface SharpHarness {
  server: ServerHandle;
  /** Per-scenario client factory: each scenario gets its own repo namespace. */
  clientFor: (repoName: string) => Promise<SharpClient>;
  unavailableReason?: string;
}

async function runScenario(
  scenario: Scenario,
  flags: CliFlags,
  sharpHarness: SharpHarness | undefined,
): Promise<ScenarioResult> {
  const skippedResult = (reason: string): LaneResult => ({
    outcome: 'error',
    reason,
  });

  return withScenarioTmpdir(
    scenario.id,
    async (workdir) => {
      let gitResult: LaneResult;
      let sharpResult: LaneResult;

      if (flags.onlySharp) {
        gitResult = skippedResult('skipped (--only-sharp)');
      } else {
        const { result } = await runGitLane(scenario, workdir);
        gitResult = await classify(scenario, result);
      }

      if (flags.onlyGit) {
        sharpResult = skippedResult('skipped (--only-git)');
      } else if (!sharpHarness) {
        sharpResult = skippedResult('sharp harness unavailable (no docker?)');
      } else if (sharpHarness.unavailableReason) {
        sharpResult = skippedResult(sharpHarness.unavailableReason);
      } else {
        const repoName = scenario.id.replaceAll('/', '__');
        const client = await sharpHarness.clientFor(repoName);
        sharpResult = await runSharpLane(scenario, workdir, { client });
        sharpResult = await classify(scenario, sharpResult);
      }

      return {
        scenario,
        git: gitResult,
        sharp: sharpResult,
        pass: flags.onlyGit
          ? gitResult.outcome === scenario.meta.expected_git_outcome
          : pass(scenario, sharpResult.outcome),
      } satisfies ScenarioResult;
    },
    { keepOnFailure: flags.keepFailures },
  );
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const start = performance.now();

  const all = await loadAllScenarios(SCENARIOS_ROOT);
  const scenarios = all.filter((s) => matchesFilter(s, flags.filter));

  if (scenarios.length === 0) {
    process.stdout.write('no scenarios matched\n');
    if (all.length === 0) {
      process.stdout.write(
        'tip: the corpus is empty — author scenarios under tests/scenarios/<category>/<lang>/<name>/\n',
      );
    }
    return 0;
  }

  // Start a Postgres container + Sharp server for the run if Sharp lane is
  // active and docker is available. Stopped at the end of the run.
  let pgContainer: PgContainer | undefined;
  let sharpHarness: SharpHarness | undefined;
  let pgUrl: string | undefined = process.env.SHARP_TEST_PG_DSN;

  if (!flags.onlyGit) {
    if (!pgUrl) {
      if (dockerAvailable()) {
        process.stdout.write('Starting ephemeral postgres:16 for the Sharp lane...\n');
        pgContainer = await startPostgres();
        pgUrl = pgContainer.url;
      } else {
        sharpHarness = {
          server: undefined as never,
          clientFor: () => Promise.reject(new Error('unreachable')),
          unavailableReason: 'docker unavailable; Sharp lane disabled',
        };
        process.stdout.write(
          '(docker unavailable — Sharp lane will record `error` for every scenario; set --only-git to skip)\n',
        );
      }
    }
    if (pgUrl && !sharpHarness) {
      process.stdout.write('Starting Sharp server...\n');
      const server = await startServer({
        dsn: pgUrl,
        port: 0,
        migrate: true,
        allowRawSha1: true,
      });
      const token = (await issueToken(server.sql, { principal: 'harness', scope: 'operator' }))
        .token;
      sharpHarness = {
        server,
        clientFor: async (repoName: string) => {
          const client = new SharpClient({ url: server.url, token, repo: repoName });
          await client.ensureRepo();
          return client;
        },
      };
    }
  }

  process.stdout.write(
    `\nRunning ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}...\n\n`,
  );

  const results: ScenarioResult[] = [];
  let failuresRoot: string | undefined;

  for (const scenario of scenarios) {
    const r = await runScenario(scenario, flags, sharpHarness);
    results.push(r);
    printScenarioLine(r);
    if (!r.pass) {
      if (!failuresRoot) failuresRoot = await makeFailuresRoot();
      await writeFailureArtifacts(failuresRoot, r);
    }
  }

  const run: RunResult = { scenarios: results, durationMs: performance.now() - start };
  printContingency(run);
  printSummary(run);

  if (failuresRoot) {
    process.stdout.write(`\nfailure artifacts: ${failuresRoot}\n`);
  }

  if (flags.jsonPath) await writeJsonReport(flags.jsonPath, run);

  await teardownSharpLane();
  if (sharpHarness?.server) await sharpHarness.server.stop();
  if (pgContainer) await pgContainer.stop();

  return results.every((r) => r.pass) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`harness crashed: ${err.stack ?? err}\n`);
    process.exit(2);
  },
);
