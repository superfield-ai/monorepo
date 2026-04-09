import type { Issue } from "@superfield/github";
import { pickCandidateDomains } from "../blueprint.ts";
import {
  projectContextFragment,
  commitStandardsFragment,
  worktreeIsolationFragment,
  blueprintReferenceFragment,
  buildBlueprintContextFragment,
  joinSections,
} from "./fragments/index.ts";

export interface DevScoutContext {
  scoutIssue: Issue;
  worktreePath: string;
  branch: string;
  phaseName: string;
  phaseGoal: string;
  featureIssues: Array<Pick<Issue, "number" | "title">>;
  /**
   * When true, layer an expanded blueprint context fragment
   * (domain-filtered `principle` + `threat` rules) on top of the narrow
   * first-turn fragment. One-shot latch managed by the dev-loop runner
   * (#78).
   */
  escalated?: boolean;
}

/**
 * Prompt for a dev-scout agent. The scout creates outside-in stubs for the
 * phase — interfaces, no-op implementations, and `it.todo()` test stubs —
 * but never implements real behavior.
 *
 * The scout PR qualifies for merge when:
 *   1. TypeScript compiles with zero errors
 *   2. All pre-existing tests pass
 *   3. Test stubs are committed using `it.todo()` / `describe.todo()`
 *   4. Every planned interface, type, and no-op stub is present
 *   5. Every downstream feature issue has a comment listing the seams it will consume
 *   6. The scout issue checklist is fully checked off
 */
export function buildDevScoutPrompt(ctx: DevScoutContext): string {
  const featureList = ctx.featureIssues
    .map((i) => `- #${i.number}: ${i.title}`)
    .join("\n");

  // Aggregate candidate domains across the scout issue and every downstream
  // feature issue so the scout sees rules for every seam it will scaffold.
  const domainSet = new Set<string>(
    pickCandidateDomains({
      title: ctx.scoutIssue.title,
      body: ctx.scoutIssue.body ?? null,
      labels: ctx.scoutIssue.labels ?? [],
    }),
  );
  for (const f of ctx.featureIssues) {
    for (const d of pickCandidateDomains({
      title: f.title,
      body: (f as { body?: string | null }).body ?? null,
      labels: (f as { labels?: string[] }).labels ?? [],
    })) {
      domainSet.add(d);
    }
  }
  const narrowContext = buildBlueprintContextFragment({
    domains: [...domainSet],
    ruleTypes: ["implementation", "antipattern"],
    budgetBytes: 4096,
  });
  const expandedContext = ctx.escalated
    ? buildBlueprintContextFragment({
        domains: [...domainSet],
        ruleTypes: ["principle", "threat"],
        budgetBytes: 4096,
        header: "## Blueprint rules (expanded context — escalation)",
      })
    : "";

  return joinSections(
    projectContextFragment(),
    `## Assignment: dev-scout for phase "${ctx.phaseName}"

- Scout issue: #${ctx.scoutIssue.number} — ${ctx.scoutIssue.title}
- Phase goal: ${ctx.phaseGoal}
- Branch: ${ctx.branch}

### Downstream feature issues you are scaffolding for

${featureList}`,
    worktreeIsolationFragment(ctx.worktreePath),
    `## Your role

The dev-scout is the first issue in every phase. You do NOT implement real \
behavior. You lay out the structural seams that the parallel feature agents \
will build against:

1. Read the body of every downstream feature issue above to understand the \
planned scope.
2. Identify every integration point: new modules, public functions, types, \
and interfaces that feature agents will depend on.
3. Create the seams:
   - TypeScript interfaces and types for all new public API surfaces
   - No-op function implementations that satisfy the type contracts \
(\`throw new Error('not implemented')\` or return typed stubs)
   - Test stubs declared with \`it.todo()\` / \`describe.todo()\` — never \
\`it.skip()\` and never failing tests
4. Ensure all existing tests still pass and the project compiles with zero \
errors.
5. For each downstream feature issue, post a comment listing the specific \
stubs and seams you created that it will consume.
6. Tick off each item in your scout issue's checklist as you complete it.

## Merge qualification

Your PR qualifies for merge when:

1. \`tsc --noEmit\` passes with zero errors
2. The full test suite passes (todo tests do not count as failures)
3. New test stubs use \`it.todo()\` — committed but not yet implemented
4. Every planned interface and stub is present in code
5. Every downstream feature issue has your handoff comment
6. Your scout issue checklist is fully checked off

You open the PR yourself once all six are true.

## Rules

- Stubs only. Do NOT implement real behavior.
- Existing tests must stay green.
- New test stubs must be \`it.todo()\` — they must not be \`it.skip()\`, must \
not be commented out, and must not fail.`,
    narrowContext,
    expandedContext,
    blueprintReferenceFragment(),
    commitStandardsFragment(),
    `## Begin

\`cd\` into your worktree and start by reading every downstream feature \
issue body.`,
  );
}
