import type { Config } from "./config.ts";
import { GitHubClient } from "@superfield/github";
import type { GitHubClientPort } from "@superfield/github";
import { hasFailedChecks, runWatchdog } from "./watchdog.ts";
import {
  runPlanCoverage,
  type PlanCoverageResult,
} from "./steps/plan-coverage.ts";
import { runIssueAudit, type IssueAuditResult } from "./steps/issue-audit.ts";
import {
  runBlueprintConformance,
  type BlueprintConformanceResult,
} from "./steps/blueprint-conformance.ts";
import { runSupervisedLoop } from "./supervised-loop.ts";

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
  console.log(
    `[planning] loop started for ${config.repositories.length} repository(ies)`,
  );
  await runSupervisedLoop({
    runOnce: async () => {
      console.log("[planning] tick start");
      await tickConfiguredRepositories(config);
    },
    delayMs: () => POLL_INTERVAL_MS,
    onError: (err) => {
      console.error(`[error] [planning] loop failed: ${formatError(err)}`);
    },
  });
}

/** Structured outcome of a single planning-loop tick per repository. */
export interface TickRepositoryResult {
  /** Issues created by the CI watchdog in this tick. */
  watchdogIssuesCreated: number[];
  watchdog:
    | { ok: true; issuesCreated: number[] }
    | { ok: false; error: string; issuesCreated: number[] };
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

export interface PlanningLoopTickOpts {
  createClient?: (token: string) => GitHubClientPort;
  tickRepository?: (
    client: GitHubClientPort,
    owner: string,
    repo: string,
  ) => Promise<TickRepositoryResult>;
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

  // Step 1: CI watchdog
  let watchdogOutcome: TickRepositoryResult["watchdog"];
  let watchdogIssuesCreated: number[] = [];
  try {
    watchdogIssuesCreated = await runWatchdogStep(client, owner, repo);
    watchdogOutcome = { ok: true, issuesCreated: watchdogIssuesCreated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    watchdogOutcome = { ok: false, error: msg, issuesCreated: [] };
    console.error(`[error] [${owner}/${repo}] watchdog failed: ${msg}`);
  }

  // Step 2: Issue audit — validate open issues against the IssueBody schema
  let issueAuditOutcome: TickRepositoryResult["issueAudit"];
  try {
    const audit = await auditFn(client, owner, repo, { cwd: process.cwd() });
    issueAuditOutcome = { ok: true, nonConformant: audit.nonConformant };
    if (audit.nonConformant.length > 0) {
      console.log(
        `[${owner}/${repo}] Issue audit: ${audit.nonConformant.length} non-conformant issue(s): ${audit.nonConformant.join(", ")}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issueAuditOutcome = { ok: false, error: msg };
    console.error(`[error] [${owner}/${repo}] issue-audit failed: ${msg}`);
  }

  // Step 3: Plan coverage — append open issues not yet referenced in Plan
  let planCoverageOutcome: TickRepositoryResult["planCoverage"];
  try {
    const coverage = await coverageFn(client, owner, repo);
    planCoverageOutcome = {
      ok: true,
      appended: coverage.appended,
      planCreated: coverage.planCreated,
    };
    if (coverage.planCreated) {
      console.log(`[${owner}/${repo}] Created Plan tracking issue`);
    }
    if (coverage.appended.length > 0) {
      console.log(
        `[${owner}/${repo}] Appended ${coverage.appended.length} issues to Plan: ${coverage.appended.join(", ")}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    planCoverageOutcome = { ok: false, error: msg };
    console.error(`[error] [${owner}/${repo}] plan-coverage failed: ${msg}`);
  }

  // Step 4: Blueprint conformance — advisory check of issues against blueprint rules
  let blueprintConformanceOutcome: TickRepositoryResult["blueprintConformance"];
  try {
    const conformance = await blueprintFn(client, owner, repo, {
      cwd: process.cwd(),
    });
    blueprintConformanceOutcome = {
      ok: true,
      issuesWithViolations: conformance.issuesWithViolations,
    };
    if (conformance.issuesWithViolations.length > 0) {
      console.log(
        `[${owner}/${repo}] Blueprint conformance: violations on issue(s) ${conformance.issuesWithViolations.join(", ")}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blueprintConformanceOutcome = { ok: false, error: msg };
    console.error(
      `[error] [${owner}/${repo}] blueprint-conformance failed: ${msg}`,
    );
  }

  return {
    watchdogIssuesCreated,
    watchdog: watchdogOutcome,
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

async function tickConfiguredRepositories(
  config: Config,
  opts: PlanningLoopTickOpts = {},
): Promise<void> {
  const createClient =
    opts.createClient ?? ((token) => new GitHubClient(token));
  const tickRepositoryFn = opts.tickRepository ?? tickRepository;

  await Promise.all(
    config.repositories.map(async (repoConfig) => {
      const user = config.users.find(
        (candidate) => candidate.handle === repoConfig.assignedUser,
      );
      if (!user) {
        console.error(
          `No user configured for ${repoConfig.owner}/${repoConfig.repo}`,
        );
        return;
      }

      try {
        const result = await tickRepositoryFn(
          createClient(user.token),
          repoConfig.owner,
          repoConfig.repo,
        );
        const auditSummary = result.issueAudit.ok
          ? `${result.issueAudit.nonConformant.length} non-conformant`
          : "error";
        const coverageSummary = result.planCoverage.ok
          ? `${result.planCoverage.appended.length} appended`
          : "error";
        const conformanceSummary = result.blueprintConformance.ok
          ? `${result.blueprintConformance.issuesWithViolations.length} with violations`
          : "error";
        console.log(
          `[${repoConfig.owner}/${repoConfig.repo}] planning tick complete: watchdog=${result.watchdogIssuesCreated.length}, issueAudit=${auditSummary}, planCoverage=${coverageSummary}, blueprint=${conformanceSummary}`,
        );
      } catch (err) {
        const msg = formatError(err);
        console.error(
          `[error] [${repoConfig.owner}/${repoConfig.repo}] planning tick failed: ${msg}`,
        );
      }
    }),
  );
}

export { tickConfiguredRepositories as tickConfiguredRepositoriesForTesting };

async function runWatchdogStep(
  client: GitHubClientPort,
  owner: string,
  repo: string,
): Promise<number[]> {
  const watchdogIssuesCreated: number[] = [];
  const sha = await client.getHeadSha(owner, repo);
  const runs = await client.getCheckRuns(owner, repo, sha);
  const failed = hasFailedChecks(runs);
  for (const run of failed) {
    const result = await runWatchdog(client, owner, repo, sha, run);
    if (result.issueCreated) {
      watchdogIssuesCreated.push(result.issue!.number);
      console.log(
        `[${owner}/${repo}] Created issue #${result.issue!.number}: ${result.issue!.title}`,
      );
    } else if (result.skipped) {
      console.log(`[${owner}/${repo}] Skipped ${run.name}: ${result.reason}`);
    }
  }
  return watchdogIssuesCreated;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
