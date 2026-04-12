import type { Issue } from "@superfield/github";
import { joinSections } from "./fragments/index.ts";

export interface IssueAuditContext {
  issues: Issue[];
}

/**
 * Prompt for the planning loop's issue audit step. Checks a batch of open
 * issues (up to 25) for schema conformance and content quality, and proposes
 * corrected bodies for any that need remediation.
 *
 * Required sections per the IssueBody schema:
 *   ## Phase          — single-line non-empty phase name
 *   ## Motivation     — non-empty prose
 *   ## Canonical docs — at least one link
 *   ## Features       — at least one checkbox
 *   ## Test Plan      — at least one checkbox
 */
export function buildIssueAuditPrompt(ctx: IssueAuditContext): string {
  const issueList = ctx.issues
    .map((i) => `### Issue #${i.number} — ${i.title}\n\n${i.body ?? "(no body)"}`)
    .join("\n\n---\n\n");

  return joinSections(
    `## Task: issue-audit

You are auditing ${ctx.issues.length} GitHub issue(s) for schema conformance and content quality.

${issueList}`,
    `## Schema requirements

Required sections (level-2 markdown headings with non-empty content):

1. \`## Phase\` — a single line immediately below the heading giving a short phase name
2. \`## Motivation\` — prose explaining why this work is needed
3. \`## Canonical docs\` — at least one URL or file link
4. \`## Features\` — at least one \`- [ ]\` or \`- [x]\` checkbox
5. \`## Test Plan\` — at least one \`- [ ]\` or \`- [x]\` checkbox

Forbidden sections (must not appear):

- \`## Issue type\` — superseded; classification lives on labels
- \`## Deliverables\` — superseded by \`## Features\`
- \`## Acceptance Criteria\` — superseded by \`## Features\`
- \`## Scope\` — superseded by \`## Features\`
- Step N / Batch N plan-order metadata in title or body

## Quality requirements

Even if all sections are structurally present, flag and fix:

- **Impossible features**: any \`## Features\` item that cannot realistically be
  implemented in a single PR (e.g. "rewrite the entire codebase", "make it 100×
  faster"). Replace with a scoped, achievable version of the same intent.
- **Untestable tests**: any \`## Test Plan\` item that cannot be verified with a
  specific assertion (e.g. "make sure it works", "test everything", "manually
  verify"). Replace with a concrete, specific, automatable assertion.
- **Vague phase name**: if \`## Phase\` is present but the name is empty, "TBD",
  or "Unknown", infer a reasonable phase name from the issue's title and context.

## Output contract

Emit exactly one JSON object with a \`reports\` array — one entry per issue:

\`\`\`json
{
  "reports": [
    {
      "issue_number": 251,
      "conformant": false,
      "missing_sections": ["## Phase"],
      "forbidden_sections": [],
      "empty_sections": [],
      "quality_issues": ["Test plan item 2 is not a specific assertion"],
      "proposed_body": "## Phase\\nFoundation\\n\\n## Motivation\\n..."
    }
  ]
}
\`\`\`

Rules:

- Every issue in the input must appear exactly once in \`reports\`.
- Set \`conformant: true\` only when all required sections are present and
  non-empty with valid content, no forbidden sections exist, and there are no
  quality issues.
- When \`conformant\` is \`false\`, always provide a \`proposed_body\` — the full
  corrected issue body.
- \`proposed_body\` must preserve all existing content that is correct; only
  add missing sections, rename forbidden ones, or replace problematic items.
- When adding a \`## Phase\` section, infer the phase name from the issue title
  and motivation (e.g. "Foundation", "Auth Layer", "Analytics").
- Emit JSON only — no surrounding prose.`,
  );
}
