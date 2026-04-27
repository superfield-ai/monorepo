import {
  projectContextFragment,
  blueprintReferenceFragment,
  joinSections,
} from "./fragments/index.ts";

export interface ReplanEvaluateContext {
  /** All open issues with their current bodies. */
  openIssues: Array<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
  }>;
  /** Current Plan body, if one exists. */
  currentPlanBody: string | null;
}

/**
 * Prompt for the `plan` command's LLM call. Groups open issues into phases,
 * assigns scouts, and emits a structured Plan JSON object.
 *
 * Replaces superfield-agents `replan-evaluate` SKILL.md, adapted to Superfield's
 * scout-gated speculative parallelization model.
 */
export function buildReplanEvaluatePrompt(ctx: ReplanEvaluateContext): string {
  const issueList = ctx.openIssues
    .map(
      (i) =>
        `### #${i.number} — ${i.title}\nLabels: ${i.labels.join(", ") || "(none)"}\n\n${i.body ?? "(no body)"}`,
    )
    .join("\n\n---\n\n");

  return joinSections(
    projectContextFragment(),
    `## Task: replan-evaluate

Group the following open issues into coherent phases, assign each phase a \
dev-scout, and emit a strict total ordering as JSON.

### Current Plan

${ctx.currentPlanBody ?? "(no Plan issue exists yet)"}

### Open issues

${issueList}`,
    blueprintReferenceFragment(),
    `## What you must decide

1. **Phase grouping** — group related issues into phases that share a delivery \
goal. Each phase needs a name, a one-sentence goal, and an ordered list of \
issues belonging to it.
2. **Phase dependencies** — a phase \`B\` may depend on phase \`A\` if every \
issue in \`A\` must close before any issue in \`B\` may begin.
3. **Scout assignment** — every phase needs exactly one dev-scout issue placed \
first. If an open issue with the \`dev-scout\` label exists for a phase, use \
it. Otherwise, emit a \`scout_spec\` so the orchestrator can create one.
4. **Risk scoring** — assign each issue a risk score from 1 (trivial) to 6 \
(unknown territory).
5. **Total ordering** — produce a strict total order across all phases. Issues \
in earlier phases come before issues in dependent phases. The scout always \
comes first within its phase. Break ties by prioritising higher-risk issues \
first.

## Output contract

Emit exactly one JSON object with this shape, and nothing else:

\`\`\`json
{
  "phases": [
    {
      "name": "Identity foundation",
      "goal": "Create the auth and session seams needed by all identity work.",
      "depends_on": [],
      "scout_issue_number": 196,
      "issue_numbers": [196, 201, 205]
    }
  ],
  "ordered_issues": [
    {
      "number": 196,
      "title": "chore: scout identity integration seams",
      "phase": "Identity foundation",
      "kind": "dev-scout",
      "risk": 5,
      "dependencies": [],
      "dependents": [201, 205],
      "parallel_safe": true
    }
  ],
  "scout_specs": []
}
\`\`\`

If a phase has no existing dev-scout issue, set \`scout_issue_number: null\` \
in the phase entry and add a \`scout_spec\` to the \`scout_specs\` array \
containing a complete \`IssueBody\` for the scout to be created.

## Rules

- Emit JSON only — no surrounding prose.
- \`ordered_issues\` is a strict total order; never two issues at the same \
position.
- Never repurpose a feature issue as a scout. Scouts must be issues whose \
labels include \`dev-scout\`.
- Phase dependencies must be acyclic.`,
  );
}
