import type { GitHubClientPort as GitHubClient } from "@superfield/github";
import {
  parsePlan,
  serializePlan,
  planContainsIssue,
  appendToPhase,
  type Plan,
  type PlanIssueMetadata,
} from "../plan.ts";

export interface PlanCoverageResult {
  /** Issue numbers that were appended to the Plan during this tick. */
  appended: number[];
  /** Issue numbers already in the Plan. */
  alreadyCovered: number[];
  /** True if the Plan tracking issue itself was created by this tick. */
  planCreated: boolean;
}

/**
 * Planning loop step: verify every open issue is referenced in the Plan.
 * Append any missing issue to the "Backlog" phase in dependency order.
 *
 * Pure deterministic — no LLM call. Uses labels to determine kind:
 *   - Has `dev-scout` label → kind: "dev-scout"
 *   - Has `ci-failure` label → kind: "ci-failure" (handled by watchdog,
 *     skipped here to avoid duplication)
 *   - Otherwise → kind: "feature"
 */
export async function runPlanCoverage(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<PlanCoverageResult> {
  const allIssues = await client.listIssues(owner, repo);

  // Exclude the Plan issue itself (label: plan) and ci-failure issues
  // (the watchdog owns those)
  const trackable = allIssues.filter(
    (i) => !i.labels.includes("plan") && !i.labels.includes("ci-failure"),
  );

  const plans = await client.listIssues(owner, repo, ["plan"]);
  let plan: Plan;
  let planCreated = false;

  if (plans.length === 0) {
    plan = { ciFailures: [], phases: [] };
    planCreated = true;
  } else {
    plan = parsePlan(plans[0]!.body ?? "");
  }

  const appended: number[] = [];
  const alreadyCovered: number[] = [];

  for (const issue of trackable) {
    if (planContainsIssue(plan, issue.number)) {
      alreadyCovered.push(issue.number);
      continue;
    }
    const entry = issueToPlanEntry(issue);
    plan = appendToPhase(plan, entry.phase, entry);
    appended.push(issue.number);
  }

  if (appended.length > 0 || planCreated) {
    const body = serializePlan(plan);
    if (planCreated) {
      await client.createIssue({
        owner,
        repo,
        title: "Plan",
        body,
        labels: ["plan"],
      });
    } else {
      await client.updateIssueBody({
        owner,
        repo,
        issue_number: plans[0]!.number,
        body,
      });
    }
  }

  return { appended, alreadyCovered, planCreated };
}

function issueToPlanEntry(issue: {
  number: number;
  title: string;
  labels: string[];
}): PlanIssueMetadata {
  const isScout = issue.labels.includes("dev-scout");
  return {
    number: issue.number,
    title: issue.title,
    phase: "Backlog",
    kind: isScout ? "dev-scout" : "feature",
    risk: 3,
    dependencies: [],
    parallel_safe: true,
  };
}
