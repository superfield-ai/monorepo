import type { GitHubClientPort as GitHubClient } from "@superfield/github";
import {
  parsePlan,
  serializePlan,
  planContainsIssue,
  appendToPhase,
  type Plan,
  type PlanIssueMetadata,
} from "../plan.ts";
import { buildPlanPlacementPrompt } from "../prompts/plan-placement.ts";
import { runLLMTask, type LLMTaskOpts } from "../llm-task.ts";
import type {
  PlanPlacementEntry,
  PlanPlacementResult,
} from "../prompts/plan-placement.ts";

export interface PlanCoverageResult {
  /** Issue numbers that were appended to the Plan during this tick. */
  appended: number[];
  /** Issue numbers already in the Plan. */
  alreadyCovered: number[];
  /** Issue numbers that could not be safely appended this tick. */
  skipped: number[];
  /** Issue numbers whose phase placement came from the LLM path. */
  llmPlaced: number[];
  /** New phase names created during this tick. */
  createdPhases: string[];
  /** True if the Plan tracking issue itself was created by this tick. */
  planCreated: boolean;
}

export interface PlanCoverageOpts {
  /** Optional pre-fetched open issues snapshot for this tick. */
  issues?: PlanCoverageSourceIssue[];
  /** Override the spawn function for testing. */
  spawn?: LLMTaskOpts["spawn"];
  /** cwd passed to the LLM subprocess. */
  cwd?: string;
}

export interface PlanCoverageSourceIssue {
  number: number;
  title: string;
  labels: string[];
  body: string | null;
}

type PendingCoverageEntry = PlanIssueMetadata & {
  originalIndex: number;
  source: "declared" | "llm";
};

/**
 * Planning loop step: verify every open issue is referenced in the Plan.
 * Deterministically places issues that already declare `## Phase`; issues
 * still missing phase placement go through an LLM batch placement step.
 */
export async function runPlanCoverage(
  client: GitHubClient,
  owner: string,
  repo: string,
  opts: PlanCoverageOpts = {},
): Promise<PlanCoverageResult> {
  const allIssues = opts.issues ?? (await client.listIssues(owner, repo));
  const trackable = allIssues.filter(
    (i) => !i.labels.includes("plan") && !i.labels.includes("ci-failure"),
  );

  const planIssue =
    allIssues.find(
      (issue) => issue.labels.includes("plan") || /^plan\b/i.test(issue.title),
    ) ?? null;

  let plan: Plan;
  let planCreated = false;

  if (!planIssue) {
    plan = { ciFailures: [], phases: [] };
    planCreated = true;
  } else {
    plan = parsePlan(planIssue.body ?? "");
  }

  const declaredEntries: PendingCoverageEntry[] = [];
  const missingPhaseIssues: Array<
    PlanCoverageSourceIssue & { originalIndex: number }
  > = [];
  const alreadyCovered: number[] = [];

  for (let index = 0; index < trackable.length; index++) {
    const issue = trackable[index];
    if (!issue) continue;
    if (planContainsIssue(plan, issue.number)) {
      alreadyCovered.push(issue.number);
      continue;
    }

    const phaseName = extractIssuePhase(issue.body);
    if (phaseName === null) {
      missingPhaseIssues.push({ ...issue, originalIndex: index });
      continue;
    }

    declaredEntries.push({
      ...buildPlanCoverageEntry(issue, phaseName),
      originalIndex: index,
      source: "declared",
    });
  }

  const llmEntries = await buildLlmPlacementEntries(
    plan,
    missingPhaseIssues,
    opts,
  );

  const allEntries = [...declaredEntries, ...llmEntries.entries];

  const createdPhases = ensurePhasesForEntries(plan, allEntries);
  if (createdPhases.length > 0) {
    plan = initializeCoveragePhases(
      plan,
      createdPhases,
      llmEntries.createdPhaseGoals,
    );
  }

  const appended: number[] = [];
  const skipped: number[] = [];
  const llmPlaced = llmEntries.entries.map((entry) => entry.number);

  for (const entry of orderEntries(plan, allEntries)) {
    if (entry.kind === "dev-scout") {
      plan = insertScoutIntoPhase(plan, entry);
      appended.push(entry.number);
      continue;
    }

    const phase = findPhase(plan, entry.phase);
    if (!phase) {
      throw new Error(
        `plan coverage cannot place feature issue #${entry.number}: phase "${entry.phase}" does not exist in the Plan`,
      );
    }

    if (phase.scoutGate === null) {
      if (entry.source === "llm") {
        skipped.push(entry.number);
        continue;
      }
      throw new Error(
        `plan coverage cannot place feature issue #${entry.number}: phase "${entry.phase}" has no scout gate`,
      );
    }

    plan = appendFeatureIntoPhase(plan, entry);
    appended.push(entry.number);
  }

  if (appended.length > 0 || planCreated || createdPhases.length > 0) {
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
      if (!planIssue) {
        throw new Error(
          "plan coverage invariant: expected existing Plan issue",
        );
      }
      await client.updateIssueBody({
        owner,
        repo,
        issue_number: planIssue.number,
        body,
      });
    }
  }

  return {
    appended,
    alreadyCovered,
    skipped,
    llmPlaced,
    createdPhases,
    planCreated,
  };
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

async function buildLlmPlacementEntries(
  plan: Plan,
  issues: Array<PlanCoverageSourceIssue & { originalIndex: number }>,
  opts: PlanCoverageOpts,
): Promise<{
  entries: PendingCoverageEntry[];
  createdPhaseGoals: Map<string, string>;
}> {
  if (issues.length === 0) {
    return { entries: [], createdPhaseGoals: new Map() };
  }

  const prompt = buildPlanPlacementPrompt({
    phases: plan.phases,
    issues: issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      html_url: "",
      state: "open",
    })),
  });
  const { result } = await runLLMTask<PlanPlacementResult>(
    {
      prompt,
      spawn: opts.spawn,
      cwd: opts.cwd,
      model: "haiku",
      loop: "plan",
      task: "plan-placement",
      jobType: "issue-audit",
    },
    (json) => parsePlanPlacementResult(json, plan, issues),
  );

  const issueMap = new Map(issues.map((issue) => [issue.number, issue]));
  const createdPhaseGoals = new Map<string, string>();
  const entries: PendingCoverageEntry[] = [];

  for (const placement of result.placements) {
    const issue = issueMap.get(placement.issue_number);
    if (!issue) {
      throw new Error(
        `plan placement returned unknown issue #${placement.issue_number}`,
      );
    }

    if (placement.create_phase) {
      createdPhaseGoals.set(placement.phase, placement.phase_goal ?? "");
    }

    entries.push({
      ...buildPlanCoverageEntry(issue, placement.phase),
      originalIndex: issue.originalIndex,
      source: "llm",
    });
  }

  return { entries, createdPhaseGoals };
}

function parsePlanPlacementResult(
  json: string,
  plan: Plan,
  issues: Array<PlanCoverageSourceIssue & { originalIndex: number }>,
): PlanPlacementResult {
  const parsed = JSON.parse(json) as Partial<PlanPlacementResult>;
  if (!Array.isArray(parsed.placements)) {
    throw new Error("missing placements");
  }

  const existingPhaseNames = new Set(plan.phases.map((phase) => phase.name));
  const expectedNumbers = new Set(issues.map((issue) => issue.number));
  const seen = new Set<number>();
  const placements: PlanPlacementEntry[] = [];

  for (const raw of parsed.placements) {
    const placement = normalizePlanPlacementEntry(raw);
    if (!expectedNumbers.has(placement.issue_number)) {
      throw new Error(`unexpected issue_number ${placement.issue_number}`);
    }
    if (seen.has(placement.issue_number)) {
      throw new Error(`duplicate issue_number ${placement.issue_number}`);
    }
    seen.add(placement.issue_number);

    const phaseExists = existingPhaseNames.has(placement.phase);
    if (placement.create_phase && phaseExists) {
      throw new Error(
        `issue #${placement.issue_number} marked create_phase for existing phase "${placement.phase}"`,
      );
    }
    if (!placement.create_phase && !phaseExists) {
      throw new Error(
        `issue #${placement.issue_number} references unknown phase "${placement.phase}" without create_phase=true`,
      );
    }
    if (
      placement.create_phase &&
      (!placement.phase_goal || placement.phase_goal.trim().length === 0)
    ) {
      throw new Error(
        `issue #${placement.issue_number} missing phase_goal for new phase "${placement.phase}"`,
      );
    }

    placements.push(placement);
  }

  if (placements.length !== issues.length) {
    throw new Error(
      `placements length mismatch: expected ${issues.length}, got ${placements.length}`,
    );
  }

  for (const issue of issues) {
    if (!seen.has(issue.number)) {
      throw new Error(`missing placement for issue_number ${issue.number}`);
    }
  }

  return { placements };
}

function normalizePlanPlacementEntry(value: unknown): PlanPlacementEntry {
  const parsed = value as Partial<PlanPlacementEntry>;
  if (typeof parsed?.issue_number !== "number") {
    throw new Error("missing issue_number");
  }
  if (typeof parsed.phase !== "string" || parsed.phase.trim().length === 0) {
    throw new Error(`missing phase for issue_number ${parsed.issue_number}`);
  }
  if (typeof parsed.create_phase !== "boolean") {
    throw new Error(
      `missing create_phase for issue_number ${parsed.issue_number}`,
    );
  }

  return {
    issue_number: parsed.issue_number,
    phase: parsed.phase.trim(),
    create_phase: parsed.create_phase,
    phase_goal:
      typeof parsed.phase_goal === "string"
        ? parsed.phase_goal.trim()
        : undefined,
  };
}

function initializeCoveragePhases(
  plan: Plan,
  phaseNames: string[],
  phaseGoals: Map<string, string>,
): Plan {
  const knownPhaseNames = new Set(plan.phases.map((phase) => phase.name));
  const phases = plan.phases.slice();

  for (const phaseName of phaseNames) {
    if (knownPhaseNames.has(phaseName)) continue;
    knownPhaseNames.add(phaseName);
    phases.push({
      name: phaseName,
      goal: phaseGoals.get(phaseName) ?? "",
      dependsOn: [],
      scoutGate: null,
      issues: [],
    });
  }

  return { ...plan, phases };
}

function ensurePhasesForEntries(
  plan: Plan,
  entries: PendingCoverageEntry[],
): string[] {
  const existing = new Set(plan.phases.map((phase) => phase.name));
  const created: string[] = [];
  for (const entry of entries) {
    if (existing.has(entry.phase)) continue;
    existing.add(entry.phase);
    created.push(entry.phase);
  }
  return created;
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

function orderEntries(
  plan: Plan,
  entries: PendingCoverageEntry[],
): PendingCoverageEntry[] {
  if (entries.length === 0) return [];

  const phaseIndex = new Map(
    plan.phases.map((phase, index) => [phase.name, index]),
  );
  const newPhaseOrder = new Map<string, number>();

  for (const entry of entries) {
    if (!phaseIndex.has(entry.phase) && !newPhaseOrder.has(entry.phase)) {
      newPhaseOrder.set(entry.phase, newPhaseOrder.size);
    }
  }

  return entries.slice().sort((left, right) => {
    const leftPhaseRank =
      phaseIndex.get(left.phase) ??
      plan.phases.length + (newPhaseOrder.get(left.phase) ?? 0);
    const rightPhaseRank =
      phaseIndex.get(right.phase) ??
      plan.phases.length + (newPhaseOrder.get(right.phase) ?? 0);
    if (leftPhaseRank !== rightPhaseRank) {
      return leftPhaseRank - rightPhaseRank;
    }

    if (left.kind !== right.kind) {
      return left.kind === "dev-scout" ? -1 : 1;
    }

    return left.originalIndex - right.originalIndex;
  });
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
