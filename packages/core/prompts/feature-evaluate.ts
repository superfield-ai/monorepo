import { projectContextFragment, blueprintReferenceFragment, joinSections } from './fragments/index.ts';

export interface FeatureEvaluateContext {
  /** The raw natural-language feature request from the user. */
  request: string;
  /** Current Plan body (for duplicate detection and phase context). */
  planBody: string | null;
  /** Open issues for duplicate detection. */
  openIssueTitles: { number: number; title: string }[];
}

/**
 * Prompt for the `feature` command's LLM call. Evaluates a feature request
 * against the PRD, the blueprint, the current Plan, and existing issues,
 * then emits a structured `IssueBody` JSON object.
 *
 * Replaces calypso-agents `feature-evaluate` SKILL.md, adapted to Superfield's
 * unified `IssueBody` schema (no more `behaviour`, `scope`, `issue_kind`).
 */
export function buildFeatureEvaluatePrompt(ctx: FeatureEvaluateContext): string {
  const issueList = ctx.openIssueTitles.length
    ? ctx.openIssueTitles.map((i) => `- #${i.number}: ${i.title}`).join('\n')
    : '(none)';

  return joinSections(
    projectContextFragment(),
    `## Task: feature-evaluate

Evaluate the following feature request and emit a structured \`IssueBody\` \
JSON object suitable for creating a GitHub issue.

### Feature request

${ctx.request}

### Current Plan

${ctx.planBody ?? '(no Plan issue exists yet)'}

### Open issues

${issueList}`,
    blueprintReferenceFragment(),
    `## What you must decide

1. **PRD alignment** — does this feature fit the product as defined in \
\`docs/prd.md\`? If it conflicts, say so in your output and propose either an \
alternative scope or a PRD amendment.
2. **Blueprint fit** — check the blueprint domains relevant to this work \
(\`arch\`, \`auth\`, \`data\`, \`process\`, \`test\`, \`ux\`, \`worker\`). Cite \
any rule IDs that apply.
3. **Duplicate detection** — search the open issues list above for exact \
duplicates, likely overlap, or improvement candidates of an existing issue. If \
this should improve an existing issue rather than become a new one, say so.
4. **Phase placement** — which phase does this belong to? If there's no \
appropriate phase yet, name a new one.
5. **Smallest clear scope** — prefer the narrowest scope that satisfies the \
request.

## Output contract

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
  "duplicate_of": null,
  "blueprint_rules_cited": ["ARCH-P-001"]
}
\`\`\`

If \`duplicate_of\` is non-null (issue number), the orchestrator will skip \
creating a new issue and report the duplicate to the user.

## Rules

- Emit JSON only — no surrounding prose, no markdown code fence labels.
- Do not invent rule IDs that don't exist in the blueprint.
- Do not include \`acceptance_criteria\` or \`scope\` — those fields no longer \
exist; everything actionable goes in \`features\` or \`test_plan\`.`,
  );
}
