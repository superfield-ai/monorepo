import type { GitHubClientPort as GitHubClient } from "@superfield/github";
import { buildFeatureEvaluatePrompt } from "../prompts/index.ts";
import { runLLMTask, type LLMTaskOpts } from "../llm-task.ts";
import { renderIssueBody, type IssueBody } from "../issue-body.ts";
import {
  parsePlan,
  serializePlan,
  appendToPhase,
  type PlanIssueMetadata,
} from "../plan.ts";

/** Shape emitted by the LLM `feature-evaluate` task. */
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
  /** Blueprint rule IDs cited by the evaluator (for visibility). */
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
}

const PLAN_LABEL = "plan";
const FEATURE_LABEL = "feature";

/**
 * One-shot `feature` command. See PRD §Command: feature.
 *
 * Steps:
 *   1. Collect — fetch open issues + current Plan body
 *   2. Evaluate (LLM) — buildFeatureEvaluatePrompt → IssueBody JSON
 *   3. Duplicate handling — if duplicate_of non-null, return without creating
 *   4. Create issue — render IssueBody and create with `feature` label
 *   5. Append to Plan in the correct phase
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

  // 2. Evaluate (LLM)
  const prompt = buildFeatureEvaluatePrompt({
    request,
    planBody: planIssues[0]?.body ?? null,
    openIssueTitles,
  });

  const { result: evaluation } = await runLLMTask<FeatureEvaluation>(
    { prompt, spawn: opts.spawn, cwd: opts.cwd },
    parseFeatureEvaluation,
  );

  // 3. Duplicate handling
  if (evaluation.duplicate_of !== null) {
    return {
      duplicateOf: evaluation.duplicate_of,
      issueCreated: null,
      planUpdated: false,
      planCreated: false,
      blueprintRulesCited: evaluation.blueprint_rules_cited ?? [],
    };
  }

  // 4. Create the issue
  const issueBody: IssueBody = {
    title: evaluation.title,
    phase: evaluation.phase,
    motivation: evaluation.motivation,
    features: evaluation.features,
    test_plan: evaluation.test_plan,
    canonical_docs: evaluation.canonical_docs,
  };
  const created = await client.createIssue({
    owner,
    repo,
    title: evaluation.title,
    body: renderIssueBody(issueBody),
    labels: [FEATURE_LABEL],
  });

  // 5. Append to the Plan in the correct phase
  const planEntry: PlanIssueMetadata = {
    number: created.number,
    title: evaluation.title,
    phase: evaluation.phase,
    kind: "feature",
    risk: evaluation.risk ?? 3,
    dependencies: evaluation.dependencies ?? [],
    parallel_safe: true,
  };

  let planCreated = false;
  let planUpdated = false;
  if (planIssues.length === 0) {
    const newPlan = appendToPhase(
      { ciFailures: [], phases: [] },
      evaluation.phase,
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
    const planIssue = planIssues[0]!;
    const plan = parsePlan(planIssue.body ?? "");
    const updated = appendToPhase(plan, evaluation.phase, planEntry);
    await client.updateIssueBody({
      owner,
      repo,
      issue_number: planIssue.number,
      body: serializePlan(updated),
    });
    planUpdated = true;
  }

  return {
    duplicateOf: null,
    issueCreated: created.number,
    planUpdated,
    planCreated,
    blueprintRulesCited: evaluation.blueprint_rules_cited ?? [],
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
  return {
    title: parsed.title,
    phase: parsed.phase,
    motivation: parsed.motivation,
    features: parsed.features,
    test_plan: parsed.test_plan,
    canonical_docs: parsed.canonical_docs ?? [],
    risk: typeof parsed.risk === "number" ? parsed.risk : undefined,
    dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
    duplicate_of:
      typeof parsed.duplicate_of === "number" ? parsed.duplicate_of : null,
    blueprint_rules_cited: parsed.blueprint_rules_cited ?? [],
  };
}
