import type { Issue } from '@superfield/github';
import { joinSections } from './fragments/index.ts';

export interface IssueAuditContext {
  issue: Issue;
}

/**
 * Prompt for the planning loop's issue audit step. Checks one open issue
 * for schema conformance and emits a structured report.
 *
 * Required sections per the IssueBody schema:
 *   ## Phase
 *   ## Motivation
 *   ## Canonical docs
 *   ## Features          (must contain checkboxes)
 *   ## Test Plan         (must contain checkboxes)
 */
export function buildIssueAuditPrompt(ctx: IssueAuditContext): string {
  return joinSections(
    `## Task: issue-audit

You are auditing one GitHub issue for schema conformance against the \
Superfield IssueBody schema.

### Issue #${ctx.issue.number} — ${ctx.issue.title}

${ctx.issue.body ?? '(no body)'}`,
    `## What you check

Required sections (must be present as level-2 markdown headings):

1. \`## Phase\` — non-empty phase name
2. \`## Motivation\` — non-empty prose
3. \`## Canonical docs\` — at least one link
4. \`## Features\` — must contain at least one \`- [ ]\` or \`- [x]\` checkbox
5. \`## Test Plan\` — must contain at least one \`- [ ]\` or \`- [x]\` checkbox

Forbidden in issue bodies:

- \`## Issue type\` — superseded; classification lives on labels
- \`## Deliverables\` — superseded by \`## Features\`
- \`## Acceptance Criteria\` — superseded by \`## Features\`
- \`## Scope\` — superseded by \`## Features\`
- \`Step N\` / \`Batch N\` plan-order metadata in title or body

## Output contract

Emit exactly one JSON object:

\`\`\`json
{
  "issue_number": ${ctx.issue.number},
  "conformant": true,
  "missing_sections": [],
  "forbidden_sections": [],
  "empty_sections": [],
  "fix_suggestions": []
}
\`\`\`

\`fix_suggestions\` should describe non-destructive normalizations the \
orchestrator can apply: add missing sections with \`TBD\` placeholders, never \
overwrite existing content. Set \`conformant\` to \`true\` only if all five \
required sections are present, non-empty, and contain checkboxes where \
required, and there are no forbidden sections.

Emit JSON only — no surrounding prose.`,
  );
}
