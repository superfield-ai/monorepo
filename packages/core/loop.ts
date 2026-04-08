import type { Config } from './config.ts';
import { GitHubClient } from '@superfield/github';
import type { GitHubClientPort } from '@superfield/github';
import { hasFailedChecks, runWatchdog } from './watchdog.ts';
import { runPlanCoverage, type PlanCoverageResult } from './steps/plan-coverage.ts';
import { runIssueAudit, type IssueAuditResult } from './steps/issue-audit.ts';
import {
  runBlueprintConformance,
  type BlueprintConformanceResult,
} from './steps/blueprint-conformance.ts';

const POLL_INTERVAL_MS = 5_000;

/**
 * The planning loop — one of three concurrent loops inside `superfield start`.
 *
 * Runs every 5 seconds per configured repository:
 *   1. CI watchdog — detect failed checks, create ci-failure issues,
 *      insert at top of Plan
 *   2. Issue audit — validate open issues against the IssueBody schema
 *   3. Plan coverage — append any open issues not yet referenced in Plan
 *   4. Blueprint conformance — advisory check against blueprint rules
 *
 * See PRD §Command: start §Planning loop.
 */
export async function runPlanningLoop(config: Config): Promise<void> {
  while (true) {
    await Promise.all(
      config.repositories.map((repoConfig) => {
        const user = config.users.find((u) => u.handle === repoConfig.assignedUser);
        if (!user) {
          console.error(`No user configured for ${repoConfig.owner}/${repoConfig.repo}`);
          return Promise.resolve();
        }
        const client = new GitHubClient(user.token);
        return tickRepository(client, repoConfig.owner, repoConfig.repo);
      }),
    );
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Structured outcome of a single planning-loop tick per repository. */
export interface TickRepositoryResult {
  /** Issues created by the CI watchdog in this tick. */
  watchdogIssuesCreated: number[];
  issueAudit:
    | { ok: true; nonConformant: number[] }
    | { ok: false; error: string };
  planCoverage:
    | { ok: true; appended: number[]; planCreated: boolean }
    | { ok: false; error: string };
  blueprintConformance:
    | { ok: true; issuesWithViolations: number[] }
    | { ok: false; error: string };
}

/** Injectable step functions — used in unit tests to avoid spawning the LLM. */
export interface TickRepositoryOpts {
  issueAudit?: (
    client: GitHubClientPort,
    owner: string,
    repo: string,
    opts: object,
  ) => Promise<IssueAuditResult>;
  blueprintConformance?: (
    client: GitHubClientPort,
    owner: string,
    repo: string,
    opts: object,
  ) => Promise<BlueprintConformanceResult>;
  planCoverage?: (
    client: GitHubClientPort,
    owner: string,
    repo: string,
  ) => Promise<PlanCoverageResult>;
}

async function tickRepository(
  client: GitHubClientPort,
  owner: string,
  repo: string,
  opts: TickRepositoryOpts = {},
): Promise<TickRepositoryResult> {
  const auditFn = opts.issueAudit ?? runIssueAudit;
  const blueprintFn = opts.blueprintConformance ?? runBlueprintConformance;
  const coverageFn = opts.planCoverage ?? runPlanCoverage;

  const watchdogIssuesCreated: number[] = [];

  // Step 1: CI watchdog
  const sha = await client.getHeadSha(owner, repo);
  const runs = await client.getCheckRuns(owner, repo, sha);
  const failed = hasFailedChecks(runs);
  for (const run of failed) {
    const result = await runWatchdog(client, owner, repo, sha, run);
    if (result.issueCreated) {
      watchdogIssuesCreated.push(result.issue!.number);
      console.log(`[${owner}/${repo}] Created issue #${result.issue!.number}: ${result.issue!.title}`);
    } else if (result.skipped) {
      console.log(`[${owner}/${repo}] Skipped ${run.name}: ${result.reason}`);
    }
  }

  // Step 2: Issue audit — validate open issues against the IssueBody schema
  let issueAuditOutcome: TickRepositoryResult['issueAudit'];
  try {
    const audit = await auditFn(client, owner, repo, { cwd: process.cwd() });
    issueAuditOutcome = { ok: true, nonConformant: audit.nonConformant };
    if (audit.nonConformant.length > 0) {
      console.log(
        `[${owner}/${repo}] Issue audit: ${audit.nonConformant.length} non-conformant issue(s): ${audit.nonConformant.join(', ')}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issueAuditOutcome = { ok: false, error: msg };
    console.error(`[${owner}/${repo}] issue-audit failed:`, err);
  }

  // Step 3: Plan coverage — append open issues not yet referenced in Plan
  let planCoverageOutcome: TickRepositoryResult['planCoverage'];
  try {
    const coverage = await coverageFn(client, owner, repo);
    planCoverageOutcome = { ok: true, appended: coverage.appended, planCreated: coverage.planCreated };
    if (coverage.planCreated) {
      console.log(`[${owner}/${repo}] Created Plan tracking issue`);
    }
    if (coverage.appended.length > 0) {
      console.log(
        `[${owner}/${repo}] Appended ${coverage.appended.length} issues to Plan: ${coverage.appended.join(', ')}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    planCoverageOutcome = { ok: false, error: msg };
    console.error(`[${owner}/${repo}] plan-coverage failed:`, err);
  }

  // Step 4: Blueprint conformance — advisory check of issues against blueprint rules
  let blueprintConformanceOutcome: TickRepositoryResult['blueprintConformance'];
  try {
    const conformance = await blueprintFn(client, owner, repo, { cwd: process.cwd() });
    blueprintConformanceOutcome = { ok: true, issuesWithViolations: conformance.issuesWithViolations };
    if (conformance.issuesWithViolations.length > 0) {
      console.log(
        `[${owner}/${repo}] Blueprint conformance: violations on issue(s) ${conformance.issuesWithViolations.join(', ')}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blueprintConformanceOutcome = { ok: false, error: msg };
    console.error(`[${owner}/${repo}] blueprint-conformance failed:`, err);
  }

  return {
    watchdogIssuesCreated,
    issueAudit: issueAuditOutcome!,
    planCoverage: planCoverageOutcome!,
    blueprintConformance: blueprintConformanceOutcome!,
  };
}

/**
 * Exported for unit testing only — drives a single tick without the while(true) loop.
 * @internal
 */
export { tickRepository as tickRepositoryForTesting };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
