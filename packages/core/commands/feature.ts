import type { GitHubClientPort as GitHubClient } from "@superfield/github";
import {
  buildFeatureEvaluatePrompt,
  buildFeatureNarrowPrompt,
} from "../prompts/index.ts";
import { runLLMTask, type LLMTaskOpts } from "../llm-task.ts";
import { renderIssueBody, type IssueBody } from "../issue-body.ts";
import { pickCandidateDomains } from "../blueprint.ts";
import {
  parsePlan,
  serializePlan,
  appendToPhase,
  type PlanIssueMetadata,
} from "../plan.ts";

/** Shape emitted by the LLM `feature-evaluate` (exploratory) task. */
export interface FeatureEvaluation {
  title: string;
  phase: string;
  motivation: string;
  features: string[];
  test_plan: string[];
  canonical_docs: string[];
  /** Risk score 1-10. Higher = more disruptive. LLM-supplied; defaults to 3 if omitted. */
  risk?: number;
  /**
   * Issue numbers that must be closed before this issue can start.
   * LLM-supplied; defaults to [] if omitted.
   */
  dependencies?: number[];
  /** When non-null, this request duplicates an existing issue and should not create a new one. */
  duplicate_of: number | null;
  /**
   * Candidate solution shape produced by the exploratory pass (#83). `null`
   * means the evaluator is declining to propose an approach (duplicate or
   * out-of-scope) and the narrowing pass should be skipped.
   */
  candidateApproach: string | null;
  /** Blueprint rule IDs cited by the evaluator (for visibility). */
  blueprint_rules_cited?: string[];
}

/** Shape emitted by the `feature-narrow` (refinement) task. */
export interface FeatureNarrowResult {
  title: string;
  phase: string;
  motivation: string;
  features: string[];
  test_plan: string[];
  canonical_docs: string[];
  risk?: number;
  dependencies?: number[];
  implementationConflicts?: string[];
  blueprint_rules_cited?: string[];
}

export interface FeatureCommandOpts {
  client: GitHubClient;
  owner: string;
  repo: string;
  /** The natural-language feature request. */
  request: string;
  spawn?: LLMTaskOpts["spawn"];
  cwd?: string;
}

export interface FeatureCommandResult {
  duplicateOf: number | null;
  issueCreated: number | null;
  planUpdated: boolean;
  planCreated: boolean;
  blueprintRulesCited: string[];
  /** True when the evaluator returned no candidate (duplicate/out-of-scope). */
  outOfScope: boolean;
  /** Conflicts reported by the narrowing pass, if any. */
  implementationConflicts: string[];
}

const PLAN_LABEL = "plan";
const FEATURE_LABEL = "feature";

/**
 * One-shot `feature` command. See PRD §Command: feature.
 *
 * Principles-first two-step flow (#83):
 *   1. Collect — fetch open issues + current Plan body.
 *   2. Evaluate (LLM, exploratory) — buildFeatureEvaluatePrompt with
 *      blueprint principles only. Emits a candidate solution shape.
 *   3. Early-exit: if the evaluator detects a duplicate or declares the
 *      request out of scope (candidateApproach === null), skip the narrowing
 *      pass entirely and return the decision.
 *   4. Narrow (LLM, refinement) — buildFeatureNarrowPrompt with
 *      implementation rules + antipatterns for the candidate domains. Emits
 *      the final IssueBody.
 *   5. Create the issue and append it to the Plan in the correct phase.
 *
 * Note on ordering: this is the INVERSE of the dev-loop flow (which narrows
 * first with implementation rules, then expands to principles/threats only
 * on escalation). For `feature`, implementation rules can over-restrict an
 * otherwise-conforming novel solution, so we let the agent find the shape
 * against principles first and only then refine against the concrete rules.
 */
export async function runFeatureCommand(
  opts: FeatureCommandOpts,
): Promise<FeatureCommandResult> {
  const { client, owner, repo, request } = opts;

  // 1. Collect
  const allIssues = await client.listIssues(owner, repo);
  const planIssues = allIssues.filter((i) => i.labels.includes(PLAN_LABEL));
  const openIssueTitles = allIssues
    .filter((i) => !i.labels.includes(PLAN_LABEL))
    .map((i) => ({ number: i.number, title: i.title }));
  const planBody = planIssues[0]?.body ?? null;

  const candidateDomains = pickCandidateDomains({
    title: request,
    body: null,
    labels: [],
  });

  // 2. Evaluate (LLM, exploratory — principles only)
  const evaluatePrompt = buildFeatureEvaluatePrompt({
    request,
    planBody,
    openIssueTitles,
    candidateDomains,
  });

  const { result: evaluation } = await runLLMTask<FeatureEvaluation>(
    {
      prompt: evaluatePrompt,
      spawn: opts.spawn,
      cwd: opts.cwd,
      model: "opus",
      jobType: "feature-evaluate",
    },
    parseFeatureEvaluation,
  );

  // 3. Duplicate handling — skip narrowing pass entirely.
  if (evaluation.duplicate_of !== null) {
    return {
      duplicateOf: evaluation.duplicate_of,
      issueCreated: null,
      planUpdated: false,
      planCreated: false,
      blueprintRulesCited: evaluation.blueprint_rules_cited ?? [],
      outOfScope: false,
      implementationConflicts: [],
    };
  }

  // 3b. Out-of-scope / no candidate — skip narrowing pass, no issue created.
  if (evaluation.candidateApproach === null) {
    return {
      duplicateOf: null,
      issueCreated: null,
      planUpdated: false,
      planCreated: false,
      blueprintRulesCited: evaluation.blueprint_rules_cited ?? [],
      outOfScope: true,
      implementationConflicts: [],
    };
  }

  // 4. Narrow (LLM, refinement — implementation rules + antipatterns)
  const narrowPrompt = buildFeatureNarrowPrompt({
    request,
    planBody,
    openIssueTitles,
    candidateDomains,
    candidateApproach: evaluation.candidateApproach,
  });

  const { result: narrowed } = await runLLMTask<FeatureNarrowResult>(
    {
      prompt: narrowPrompt,
      spawn: opts.spawn,
      cwd: opts.cwd,
      model: "opus",
      jobType: "feature-evaluate",
    },
    parseFeatureNarrow,
  );

  // 5. Create the issue (from the narrowed result)
  const issueBody: IssueBody = {
    title: narrowed.title,
    phase: narrowed.phase,
    motivation: narrowed.motivation,
    features: narrowed.features,
    test_plan: narrowed.test_plan,
    canonical_docs: narrowed.canonical_docs,
  };
  const created = await client.createIssue({
    owner,
    repo,
    title: narrowed.title,
    body: renderIssueBody(issueBody),
    labels: [FEATURE_LABEL],
  });

  // 6. Append to the Plan in the correct phase (prefer narrow-pass values,
  // fall back to evaluator values for risk/dependencies).
  const planEntry: PlanIssueMetadata = {
    number: created.number,
    title: narrowed.title,
    phase: narrowed.phase,
    kind: "feature",
    risk: narrowed.risk ?? evaluation.risk ?? 3,
    dependencies: narrowed.dependencies ?? evaluation.dependencies ?? [],
    parallel_safe: true,
  };

  let planCreated = false;
  let planUpdated = false;
  if (planIssues.length === 0) {
    const newPlan = appendToPhase(
      { ciFailures: [], phases: [] },
      narrowed.phase,
      planEntry,
    );
    await client.createIssue({
      owner,
      repo,
      title: "Plan",
      body: serializePlan(newPlan),
      labels: [PLAN_LABEL],
    });
    planCreated = true;
  } else {
    const planIssue = planIssues[0];
    if (!planIssue) {
      throw new Error("plan issue list is unexpectedly empty");
    }
    const plan = parsePlan(planIssue.body ?? "");
    const updated = appendToPhase(plan, narrowed.phase, planEntry);
    await client.updateIssueBody({
      owner,
      repo,
      issue_number: planIssue.number,
      body: serializePlan(updated),
    });
    planUpdated = true;
  }

  // Merge rule citations from both passes, de-duplicated.
  const mergedCitations = Array.from(
    new Set([
      ...(evaluation.blueprint_rules_cited ?? []),
      ...(narrowed.blueprint_rules_cited ?? []),
    ]),
  );

  return {
    duplicateOf: null,
    issueCreated: created.number,
    planUpdated,
    planCreated,
    blueprintRulesCited: mergedCitations,
    outOfScope: false,
    implementationConflicts: narrowed.implementationConflicts ?? [],
  };
}

function parseFeatureEvaluation(json: string): FeatureEvaluation {
  const parsed = JSON.parse(json) as Partial<FeatureEvaluation>;
  if (typeof parsed.title !== "string") throw new Error("missing title");
  if (typeof parsed.phase !== "string") throw new Error("missing phase");
  if (typeof parsed.motivation !== "string")
    throw new Error("missing motivation");
  if (!Array.isArray(parsed.features))
    throw new Error("missing features array");
  if (!Array.isArray(parsed.test_plan))
    throw new Error("missing test_plan array");
  if (parsed.duplicate_of !== null && typeof parsed.duplicate_of !== "number") {
    throw new Error("invalid duplicate_of");
  }
  if (
    parsed.candidateApproach !== null &&
    parsed.candidateApproach !== undefined &&
    typeof parsed.candidateApproach !== "string"
  ) {
    throw new Error("invalid candidateApproach");
  }
  return {
    title: parsed.title,
    phase: parsed.phase,
    motivation: parsed.motivation,
    features: parsed.features,
    test_plan: parsed.test_plan,
    canonical_docs: parsed.canonical_docs ?? [],
    risk: typeof parsed.risk === "number" ? parsed.risk : undefined,
    dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
    duplicate_of: parsed.duplicate_of ?? null,
    candidateApproach: parsed.candidateApproach ?? null,
    blueprint_rules_cited: parsed.blueprint_rules_cited ?? [],
  };
}

function parseFeatureNarrow(json: string): FeatureNarrowResult {
  const parsed = JSON.parse(json) as Partial<FeatureNarrowResult>;
  if (typeof parsed.title !== "string") throw new Error("missing title");
  if (typeof parsed.phase !== "string") throw new Error("missing phase");
  if (typeof parsed.motivation !== "string")
    throw new Error("missing motivation");
  if (!Array.isArray(parsed.features))
    throw new Error("missing features array");
  if (!Array.isArray(parsed.test_plan))
    throw new Error("missing test_plan array");
  if (
    parsed.implementationConflicts !== undefined &&
    !Array.isArray(parsed.implementationConflicts)
  ) {
    throw new Error("invalid implementationConflicts");
  }
  return {
    title: parsed.title,
    phase: parsed.phase,
    motivation: parsed.motivation,
    features: parsed.features,
    test_plan: parsed.test_plan,
    canonical_docs: parsed.canonical_docs ?? [],
    risk: typeof parsed.risk === "number" ? parsed.risk : undefined,
    dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
    implementationConflicts: parsed.implementationConflicts ?? [],
    blueprint_rules_cited: parsed.blueprint_rules_cited ?? [],
  };
}
