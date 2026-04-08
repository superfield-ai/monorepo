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

export interface PlanCoverageSourceIssue {
  number: number;
  title: string;
  labels: string[];
  body: string | null;
}

/**
 * Planning loop step: verify every open issue is referenced in the Plan.
 * Append any missing issue to the phase declared in its body, preserving
 * scout-first ordering and dependency metadata.
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
    const phaseName = planCreated
      ? (extractIssuePhase(issue.body) ?? "Backlog")
      : extractIssuePhase(issue.body);
    if (phaseName === null) {
      throw new Error(
        `plan coverage cannot place issue #${issue.number}: missing ## Phase section`,
      );
    }

    const entry = buildPlanCoverageEntry(issue, phaseName);
    if (planCreated) {
      plan = appendToPhase(plan, entry.phase, entry);
    } else if (entry.kind === "dev-scout") {
      plan = insertScoutIntoPhase(plan, entry);
    } else {
      plan = appendFeatureIntoPhase(plan, entry);
    }
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

export function buildPlanCoverageEntry(
  issue: PlanCoverageSourceIssue,
  phase: string,
): PlanIssueMetadata {
  const isScout = issue.labels.includes("dev-scout");
  return {
    number: issue.number,
    title: issue.title,
    phase,
    kind: isScout ? "dev-scout" : "feature",
    risk: 3,
    dependencies: [],
    parallel_safe: true,
  };
}

function appendFeatureIntoPhase(plan: Plan, entry: PlanIssueMetadata): Plan {
  const phase = findPhase(plan, entry.phase);
  if (!phase) {
    throw new Error(
      `plan coverage cannot place feature issue #${entry.number}: phase "${entry.phase}" does not exist in the Plan`,
    );
  }
  if (phase.scoutGate === null) {
    throw new Error(
      `plan coverage cannot place feature issue #${entry.number}: phase "${entry.phase}" has no scout gate`,
    );
  }

  return appendToPhase(plan, entry.phase, {
    ...entry,
    dependencies: [phase.scoutGate],
  });
}

function insertScoutIntoPhase(plan: Plan, entry: PlanIssueMetadata): Plan {
  const phase = findPhase(plan, entry.phase);
  if (!phase) {
    return {
      ...plan,
      phases: [
        ...plan.phases,
        {
          name: entry.phase,
          goal: "",
          dependsOn: [],
          scoutGate: entry.number,
          issues: [entry],
        },
      ],
    };
  }

  if (phase.scoutGate !== null && phase.scoutGate !== entry.number) {
    throw new Error(
      `plan coverage cannot place scout issue #${entry.number}: phase "${entry.phase}" already has scout gate #${phase.scoutGate}`,
    );
  }

  const issues = phase.issues.map((issue) =>
    issue.kind === "feature" && !issue.dependencies.includes(entry.number)
      ? {
          ...issue,
          dependencies: [entry.number, ...issue.dependencies],
        }
      : issue,
  );

  const nextPhase: Plan["phases"][number] = {
    ...phase,
    scoutGate: entry.number,
    issues: [entry, ...issues.filter((issue) => issue.number !== entry.number)],
  };

  return {
    ...plan,
    phases: plan.phases.map((candidate) =>
      candidate.name === entry.phase ? nextPhase : candidate,
    ),
  };
}

function findPhase(plan: Plan, phaseName: string) {
  return plan.phases.find((phase) => phase.name === phaseName) ?? null;
}

function extractIssuePhase(body: string | null): string | null {
  if (body === null) return null;
  const lines = body.split("\n");
  const phaseIndex = lines.findIndex((line) => line.trim() === "## Phase");
  if (phaseIndex < 0) return null;
  const phase = lines[phaseIndex + 1]?.trim() ?? "";
  return phase.length > 0 ? phase : null;
}
