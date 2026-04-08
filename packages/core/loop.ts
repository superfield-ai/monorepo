import type { Config } from './config.ts';
import { GitHubClient } from '@superfield/github';
import { hasFailedChecks, runWatchdog } from './watchdog.ts';
import { runPlanCoverage } from './steps/plan-coverage.ts';

const POLL_INTERVAL_MS = 5_000;

/**
 * The planning loop — one of three concurrent loops inside `superfield start`.
 *
 * Runs every 5 seconds per configured repository:
 *   1. CI watchdog — detect failed checks, create ci-failure issues,
 *      insert at top of Plan
 *   2. Issue audit — (wired separately; off by default until Phase 3 step
 *      is stabilised against a real LLM)
 *   3. Plan coverage — append any open issues not yet referenced in Plan
 *   4. Blueprint conformance — (Phase 4)
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

async function tickRepository(client: GitHubClient, owner: string, repo: string): Promise<void> {
  // Step 1: CI watchdog
  const sha = await client.getHeadSha(owner, repo);
  const runs = await client.getCheckRuns(owner, repo, sha);
  const failed = hasFailedChecks(runs);
  for (const run of failed) {
    const result = await runWatchdog(client, owner, repo, sha, run);
    if (result.issueCreated) {
      console.log(`[${owner}/${repo}] Created issue #${result.issue!.number}: ${result.issue!.title}`);
    } else if (result.skipped) {
      console.log(`[${owner}/${repo}] Skipped ${run.name}: ${result.reason}`);
    }
  }

  // Step 3: Plan coverage (step 2 issue-audit and step 4 blueprint-conformance
  // are wired separately because they make LLM calls)
  try {
    const coverage = await runPlanCoverage(client, owner, repo);
    if (coverage.planCreated) {
      console.log(`[${owner}/${repo}] Created Plan tracking issue`);
    }
    if (coverage.appended.length > 0) {
      console.log(
        `[${owner}/${repo}] Appended ${coverage.appended.length} issues to Plan: ${coverage.appended.join(', ')}`,
      );
    }
  } catch (err) {
    console.error(`[${owner}/${repo}] plan-coverage failed:`, err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
