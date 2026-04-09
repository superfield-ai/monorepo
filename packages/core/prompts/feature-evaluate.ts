import {
  projectContextFragment,
  blueprintReferenceFragment,
  joinSections,
} from "./fragments/index.ts";
import { buildBlueprintContextFragment } from "./fragments/blueprint-context.ts";

export interface FeatureEvaluateContext {
  /** The raw natural-language feature request from the user. */
  request: string;
  /** Current Plan body (for duplicate detection and phase context). */
  planBody: string | null;
  /** Open issues for duplicate detection. */
  openIssueTitles: { number: number; title: string }[];
  /**
   * Candidate blueprint domains for the request, used to scope the
   * principles-only blueprint fragment. See `pickCandidateDomains()`.
   */
  candidateDomains: string[];
}

/**
 * Prompt for the `feature` command's first (exploratory) LLM pass.
 *
 * Principles-first flow (#83): this initial prompt includes blueprint
 * **principles only** — no implementation rules, antipatterns, or threats —
 * so the evaluator can explore solution shape without being prematurely
 * constrained by specific TS rules. A subsequent narrowing pass
 * (`buildFeatureNarrowPrompt`) layers in implementation rules for the
 * candidate approach the evaluator picks here.
 */
export function buildFeatureEvaluatePrompt(
  ctx: FeatureEvaluateContext,
): string {
  const issueList = ctx.openIssueTitles.length
    ? ctx.openIssueTitles.map((i) => `- #${i.number}: ${i.title}`).join("\n")
    : "(none)";

  const principlesFragment = buildBlueprintContextFragment({
    domains: ctx.candidateDomains,
    ruleTypes: ["principle"],
    budgetBytes: 4096,
    header:
      "## Blueprint principles (exploratory context — shape the solution freely)",
  });

  return joinSections(
    projectContextFragment(),
    `## Task: feature-evaluate (principles-first exploratory pass)

Evaluate the following feature request and emit a structured JSON object \
describing your decision and a candidate solution shape. A second narrowing \
pass will apply implementation rules to your chosen candidate.

### Feature request

${ctx.request}

### Current Plan

${ctx.planBody ?? "(no Plan issue exists yet)"}

### Open issues

${issueList}`,
    principlesFragment,
    `**Exploratory instruction:** Propose a solution shape. Do not try to match \
specific implementation rules yet — those will be applied in a narrowing pass \
after you pick a candidate approach.`,
    blueprintReferenceFragment(),
    `## What you must decide

1. **PRD alignment** — does this feature fit the product as defined in \
\`docs/prd.md\`? If it conflicts, say so and propose either an alternative \
scope or a PRD amendment (set \`candidateApproach\` to \`null\` if out of \
scope).
2. **Duplicate detection** — search the open issues list for exact duplicates \
or substantial overlap. If this feature is substantially the same as an \
existing open issue, set \`duplicate_of\` to that issue number and set \
\`candidateApproach\` to \`null\`; otherwise set \`duplicate_of\` to \`null\`.
3. **Phase placement** — which phase does this belong to?
4. **Smallest clear scope** — prefer the narrowest scope that satisfies the \
request.
5. **Candidate approach** — in \`candidateApproach\`, describe in 1–3 \
sentences the solution shape you'd propose (the "how"). This string will be \
fed verbatim to the narrowing pass. Use \`null\` only if you're returning a \
duplicate or declaring the request out of scope.

## Output contract

Emit exactly one JSON object with this shape, and nothing else:

\`\`\`json
{
  "title": "feat: short conventional-commit-style title",
  "phase": "Phase name",
  "motivation": "1–3 sentences on why this work exists",
  "candidateApproach": "1–3 sentences describing the proposed solution shape, or null",
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
  "duplicate_of": null,
  "blueprint_rules_cited": ["ARCH-P-001"]
}
\`\`\`

If \`duplicate_of\` is non-null (issue number) or \`candidateApproach\` is \
\`null\` (out-of-scope), the orchestrator will skip the narrowing pass and \
report the result directly.

## Rules

- Emit JSON only — no surrounding prose, no markdown code fence labels.
- Do not invent rule IDs that don't exist in the blueprint.
- Do not include \`acceptance_criteria\` or \`scope\` — those fields no longer \
exist; everything actionable goes in \`features\` or \`test_plan\`.`,
  );
}
