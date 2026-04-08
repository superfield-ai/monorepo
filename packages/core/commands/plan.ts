import type {
  GitHubClientPort as GitHubClient,
  Issue,
} from "@superfield/github";
import { buildReplanEvaluatePrompt } from "../prompts/index.ts";
import { runLLMTask, type LLMTaskOpts } from "../llm-task.ts";
import {
  serializePlan,
  validatePlan,
  type Plan,
  type PlanIssueMetadata,
  type PlanPhase,
} from "../plan.ts";
import { renderIssueBody, type IssueBody } from "../issue-body.ts";

/** Shape emitted by the LLM `replan-evaluate` task. */
export interface PlanProposal {
  phases: Array<{
    name: string;
    goal: string;
    depends_on: string[];
    scout_issue_number: number | null;
    issue_numbers: Array<number | null>;
  }>;
  ordered_issues: Array<{
    number: number | null;
    title: string;
    phase: string;
    kind: "dev-scout" | "feature" | "ci-failure";
    risk: number;
    dependencies: number[];
    dependents?: number[];
    parallel_safe: boolean;
    /** Set when number is null — used to create the scout issue */
    scout_spec_index?: number;
  }>;
  scout_specs: Array<{
    title: string;
    phase: string;
    motivation: string;
    features: string[];
    test_plan: string[];
    canonical_docs: string[];
  }>;
}

export interface PlanCommandOpts {
  client: GitHubClient;
  owner: string;
  repo: string;
  spawn?: LLMTaskOpts["spawn"];
  cwd?: string;
}

export interface PlanCommandResult {
  scoutsCreated: number[];
  planUpdated: boolean;
  planCreated: boolean;
  validationErrors: string[];
}

const PLAN_LABEL = "plan";
const SCOUT_LABEL = "dev-scout";

/**
 * One-shot replan command. See PRD §Command: plan.
 *
 * Steps:
 *   1. Collect — fetch open issues + current Plan body
 *   2. Evaluate (LLM) — buildReplanEvaluatePrompt → JSON
 *   3. Create scouts — for each null-numbered phase, create the GitHub issue
 *   4. Validate — strict total order, scout-first, acyclic phase deps
 *   5. Apply — render Plan body, update tracking issue
 */
export async function runPlanCommand(
  opts: PlanCommandOpts,
): Promise<PlanCommandResult> {
  const { client, owner, repo } = opts;

  // 1. Collect
  const allIssues = await client.listIssues(owner, repo);
  const { planIssues, candidates } = collectPlanInputs(allIssues);

  if (candidates.length === 0) {
    return {
      scoutsCreated: [],
      planUpdated: false,
      planCreated: false,
      validationErrors: [],
    };
  }

  // 2. Evaluate (LLM)
  const prompt = buildReplanEvaluatePrompt({
    openIssues: candidates.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      labels: i.labels,
    })),
    currentPlanBody: planIssues[0]?.body ?? null,
  });

  const { result: proposal } = await runLLMTask<PlanProposal>(
    { prompt, spawn: opts.spawn, cwd: opts.cwd },
    parseProposal,
  );

  // 3. Create scouts for any null-numbered slots
  const scoutsCreated: number[] = [];
  if (proposal.scout_specs && proposal.scout_specs.length > 0) {
    for (let specIdx = 0; specIdx < proposal.scout_specs.length; specIdx++) {
      const spec = proposal.scout_specs[specIdx]!;
      const issueBody: IssueBody = {
        title: spec.title,
        phase: spec.phase,
        motivation: spec.motivation ?? "",
        features: spec.features ?? [],
        test_plan: spec.test_plan ?? [],
        canonical_docs: spec.canonical_docs ?? [],
      };
      const created = await client.createIssue({
        owner,
        repo,
        title: spec.title,
        body: renderIssueBody(issueBody),
        labels: [SCOUT_LABEL],
      });
      scoutsCreated.push(created.number);

      // Patch the proposal: replace null number with the real one
      patchScoutNumber(proposal, specIdx, created.number);
    }
  }

  // 4. Validate
  const validationErrors = validateProposal(proposal);
  if (validationErrors.length > 0) {
    return {
      scoutsCreated,
      planUpdated: false,
      planCreated: false,
      validationErrors,
    };
  }

  // 5. Apply: render Plan body and write
  const plan = buildPlanFromProposal(proposal);
  const planErrors = validatePlan(plan);
  if (planErrors.length > 0) {
    return {
      scoutsCreated,
      planUpdated: false,
      planCreated: false,
      validationErrors: planErrors.map((error) => error.message),
    };
  }
  const body = serializePlan(plan);

  let planCreated = false;
  if (planIssues.length === 0) {
    await client.createIssue({
      owner,
      repo,
      title: "Plan",
      body,
      labels: [PLAN_LABEL],
    });
    planCreated = true;
  } else {
    await client.updateIssueBody({
      owner,
      repo,
      issue_number: planIssues[0]!.number,
      body,
    });
  }

  return {
    scoutsCreated,
    planUpdated: !planCreated,
    planCreated,
    validationErrors: [],
  };
}

/** Scout seam for #54 issue-audit gating before plan evaluation. */
export function collectPlanInputs(allIssues: Issue[]): {
  planIssues: Issue[];
  candidates: Issue[];
} {
  return {
    planIssues: allIssues.filter((i) => i.labels.includes(PLAN_LABEL)),
    candidates: allIssues.filter(
      (i) => !i.labels.includes(PLAN_LABEL) && !i.labels.includes("ci-failure"),
    ),
  };
}

function parseProposal(json: string): PlanProposal {
  const parsed = JSON.parse(json) as Partial<PlanProposal>;
  if (!Array.isArray(parsed.phases)) throw new Error("missing phases array");
  if (!Array.isArray(parsed.ordered_issues))
    throw new Error("missing ordered_issues array");
  const rawSpecs = (parsed.scout_specs ?? []) as Array<Record<string, unknown>>;
  const specs = rawSpecs.map((s) => ({
    ...(s as PlanProposal["scout_specs"][number]),
    canonical_docs: Array.isArray(s["canonical_docs"])
      ? (s["canonical_docs"] as string[])
      : [],
  }));
  return {
    phases: parsed.phases,
    ordered_issues: parsed.ordered_issues,
    scout_specs: specs,
  };
}

function patchScoutNumber(
  proposal: PlanProposal,
  specIdx: number,
  realNumber: number,
): void {
  const spec = proposal.scout_specs[specIdx]!;
  const phaseName = spec.phase;

  // Find an existing null-numbered dev-scout slot for this phase
  let patched = false;
  for (const issue of proposal.ordered_issues) {
    if (
      issue.number === null &&
      issue.kind === "dev-scout" &&
      issue.phase === phaseName
    ) {
      issue.number = realNumber;
      patched = true;
      break;
    }
  }

  // If the LLM didn't include a null slot, insert the scout at the front of its phase
  if (!patched) {
    const firstPhaseIdx = proposal.ordered_issues.findIndex(
      (i) => i.phase === phaseName,
    );
    const insertAt =
      firstPhaseIdx >= 0 ? firstPhaseIdx : proposal.ordered_issues.length;
    proposal.ordered_issues.splice(insertAt, 0, {
      number: realNumber,
      title: spec.title,
      phase: phaseName,
      kind: "dev-scout",
      risk: 3,
      dependencies: [],
      parallel_safe: true,
    });
  }

  // Ensure all features in the same phase depend on the scout
  for (const other of proposal.ordered_issues) {
    if (
      other.phase === phaseName &&
      other.kind === "feature" &&
      !other.dependencies.includes(realNumber)
    ) {
      other.dependencies.push(realNumber);
    }
  }

  // Patch the matching phase block
  for (const phase of proposal.phases) {
    if (phase.name === phaseName) {
      phase.scout_issue_number = realNumber;
      if (!phase.issue_numbers.includes(realNumber)) {
        phase.issue_numbers.unshift(realNumber);
      }
      break;
    }
  }
}

function validateProposal(proposal: PlanProposal): string[] {
  const errors: string[] = [];
  const seen = new Set<number>();

  // Strict total order: no duplicate issue numbers
  for (const issue of proposal.ordered_issues) {
    if (issue.number === null) {
      errors.push(`null-numbered issue in ordered_issues: ${issue.title}`);
      continue;
    }
    if (seen.has(issue.number)) {
      errors.push(`duplicate issue #${issue.number} in ordered_issues`);
    }
    seen.add(issue.number);
  }

  // Each phase has exactly one scout, placed first
  for (const phase of proposal.phases) {
    const phaseIssues = proposal.ordered_issues.filter(
      (i) => i.phase === phase.name,
    );
    if (phaseIssues.length === 0) {
      errors.push(`phase "${phase.name}" has no issues`);
      continue;
    }
    const scouts = phaseIssues.filter((i) => i.kind === "dev-scout");
    if (scouts.length === 0) {
      errors.push(`phase "${phase.name}" has no dev-scout`);
    } else if (scouts.length > 1) {
      errors.push(
        `phase "${phase.name}" has ${scouts.length} dev-scouts (must be exactly 1)`,
      );
    } else if (phaseIssues[0]!.kind !== "dev-scout") {
      errors.push(`phase "${phase.name}" scout is not first`);
    }
  }

  // Acyclic phase dependencies
  const phaseNames = new Set(proposal.phases.map((p) => p.name));
  const adj = new Map<string, string[]>();
  for (const phase of proposal.phases) {
    adj.set(
      phase.name,
      phase.depends_on.filter((d) => phaseNames.has(d)),
    );
  }
  if (hasCycle(adj)) {
    errors.push("phase dependency graph has a cycle");
  }

  return errors;
}

function hasCycle(adj: Map<string, string[]>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const node of adj.keys()) color.set(node, WHITE);

  function visit(node: string): boolean {
    color.set(node, GRAY);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE && visit(node)) return true;
  }
  return false;
}

function buildPlanFromProposal(proposal: PlanProposal): Plan {
  const phases: PlanPhase[] = proposal.phases.map((p) => {
    const issues: PlanIssueMetadata[] = proposal.ordered_issues
      .filter((i) => i.phase === p.name && i.number !== null)
      .map((i) => ({
        number: i.number!,
        title: i.title,
        phase: i.phase,
        kind: i.kind,
        risk: i.risk,
        dependencies: i.dependencies,
        dependents: i.dependents ?? [],
        parallel_safe: i.parallel_safe,
      }));
    return {
      name: p.name,
      goal: p.goal,
      dependsOn: p.depends_on,
      scoutGate: p.scout_issue_number,
      issues,
    };
  });
  return { ciFailures: [], phases };
}
