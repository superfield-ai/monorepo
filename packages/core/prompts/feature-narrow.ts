import {
  projectContextFragment,
  blueprintReferenceFragment,
  joinSections,
} from "./fragments/index.ts";
import { buildBlueprintContextFragment } from "./fragments/blueprint-context.ts";

export interface FeatureNarrowContext {
  /** The original natural-language feature request. */
  request: string;
  /** Current Plan body (for phase context). */
  planBody: string | null;
  /** Open issues (kept for parity with the first pass; informational). */
  openIssueTitles: { number: number; title: string }[];
  /** Candidate blueprint domains to scope the implementation fragment. */
  candidateDomains: string[];
  /**
   * The candidate solution shape produced by the first (exploratory) pass.
   * This string is referenced verbatim in the prompt so the agent knows what
   * it's refining.
   */
  candidateApproach: string;
}

/**
 * Prompt for the `feature` command's second (narrowing) LLM pass.
 *
 * Principles-first flow (#83): the first pass explored solution shape using
 * blueprint principles only. This pass supplies the **implementation rules**
 * and antipatterns for the candidate domains, and asks the agent to refine
 * the previously-proposed `candidateApproach` into a final `IssueBody`. If an
 * implementation rule genuinely conflicts with the candidate, the agent may
 * record it in `implementationConflicts: string[]`.
 */
export function buildFeatureNarrowPrompt(ctx: FeatureNarrowContext): string {
  const issueList = ctx.openIssueTitles.length
    ? ctx.openIssueTitles.map((i) => `- #${i.number}: ${i.title}`).join("\n")
    : "(none)";

  const implementationFragment = buildBlueprintContextFragment({
    domains: ctx.candidateDomains,
    ruleTypes: ["implementation", "antipattern"],
    budgetBytes: 4096,
    header:
      "## Blueprint implementation rules (narrowing pass — refine the solution)",
  });

  return joinSections(
    projectContextFragment(),
    `## Task: feature-narrow (implementation-rules narrowing pass)

You previously proposed the following candidate approach for a feature \
request. Refine it to satisfy the blueprint implementation rules below, and \
emit the final \`IssueBody\` JSON.

### Feature request

${ctx.request}

### Previously proposed candidate approach

${ctx.candidateApproach}

### Current Plan

${ctx.planBody ?? "(no Plan issue exists yet)"}

### Open issues (for context)

${issueList}`,
    implementationFragment,
    `**Narrowing instruction:** You previously proposed ${JSON.stringify(
      ctx.candidateApproach,
    )}. Refine it to satisfy these implementation rules; if a rule genuinely \
conflicts with your approach, note the conflict in \
\`implementationConflicts: string[]\` and propose an alternative. Emit the \
final \`IssueBody\`.`,
    blueprintReferenceFragment(),
    `## Output contract

Emit exactly one JSON object with this shape, and nothing else:

\`\`\`json
{
  "title": "feat: short conventional-commit-style title",
  "phase": "Phase name",
  "motivation": "1–3 sentences on why this work exists",
  "features": [
    "First feature/deliverable",
    "Second feature/deliverable"
  ],
  "test_plan": [
    "First test scenario",
    "Second test scenario"
  ],
  "canonical_docs": [
    "docs/prd.md#section",
    "blueprint/rules/blueprints/<domain>.yaml"
  ],
  "implementationConflicts": [
    "RULE-ID: description of the conflict and the alternative chosen"
  ],
  "blueprint_rules_cited": ["ARCH-I-001"]
}
\`\`\`

\`implementationConflicts\` is optional — omit or use \`[]\` when your \
refined approach satisfies all applicable implementation rules.

## Rules

- Emit JSON only — no surrounding prose, no markdown code fence labels.
- Do not invent rule IDs that don't exist in the blueprint.
- Do not re-open duplicate detection — the first pass already decided that.
- Keep the feature title/phase consistent with the candidate unless an \
implementation rule forces a change (and in that case record a conflict).`,
  );
}
