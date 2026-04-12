import type { Issue } from "@superfield/github";
import type { PlanPhase } from "../plan.ts";
import { joinSections } from "./fragments/index.ts";

export interface PlanPlacementContext {
  /** Existing plan phases (may be empty on first run). */
  phases: PlanPhase[];
  /** Uncovered issues that need phase assignment (up to 25). */
  issues: Issue[];
}

export interface PlanPlacementEntry {
  issue_number: number;
  /** Phase name to assign. Must match an existing phase name exactly, or be a
   *  new name when create_phase is true. */
  phase: string;
  /** True when this is a brand-new phase not present in the plan. */
  create_phase: boolean;
  /** Required when create_phase is true. One sentence describing the phase goal. */
  phase_goal?: string;
}

export interface PlanPlacementResult {
  placements: PlanPlacementEntry[];
}

/**
 * Prompt for the planning loop's plan-placement step. Given the current set
 * of plan phases and a batch of uncovered issues (up to 25), the LLM assigns
 * each issue to a phase — existing or new.
 *
 * Seeing all issues together lets the LLM make coherent grouping decisions
 * (e.g. recognising that several new issues belong in the same new phase)
 * rather than deciding one issue at a time.
 */
export function buildPlanPlacementPrompt(ctx: PlanPlacementContext): string {
  const phaseList =
    ctx.phases.length > 0
      ? ctx.phases
          .map(
            (p) =>
              `- **${p.name}**${p.goal ? `: ${p.goal}` : ""}` +
              (p.scoutGate !== null ? ` (scout gate: #${p.scoutGate})` : " (no scout gate yet)"),
          )
          .join("\n")
      : "(no phases defined yet — you may create the first one)";

  const issueList = ctx.issues
    .map(
      (i) =>
        `### Issue #${i.number} — ${i.title}\n\n${(i.body ?? "(no body)").slice(0, 1500)}`,
    )
    .join("\n\n---\n\n");

  return joinSections(
    `## Task: plan-placement

You are assigning ${ctx.issues.length} open GitHub issue(s) to phases in the project plan.

## Current plan phases

${phaseList}

## Issues to place

${issueList}`,
    `## What to do

For each issue decide which phase it belongs to:

- If the issue fits naturally into an existing phase by scope or goal, assign it
  there and set \`create_phase: false\`.
- If no existing phase is a good fit, create a new phase. Use a short,
  descriptive noun phrase (e.g. "Foundation", "API Layer", "Analytics").
- Group related issues into the same new phase rather than creating many
  one-issue phases.
- Prefer existing phases over new ones unless the issue is clearly out of scope
  for all of them.
- \`dev-scout\` labelled issues are the first issue in their phase; assign them
  to the phase they are scouting (existing or new).

## Output contract

Emit exactly one JSON object:

\`\`\`json
{
  "placements": [
    {
      "issue_number": 251,
      "phase": "Foundation",
      "create_phase": false
    },
    {
      "issue_number": 252,
      "phase": "Analytics",
      "create_phase": true,
      "phase_goal": "Implement analytics tracking and reporting dashboards"
    }
  ]
}
\`\`\`

Rules:

- Every issue in the input must appear exactly once in \`placements\`.
- \`create_phase: true\` only for phases not listed under "Current plan phases".
- When \`create_phase: true\`, include \`phase_goal\` — one sentence.
- Emit JSON only — no surrounding prose.`,
  );
}
