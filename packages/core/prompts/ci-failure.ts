import type { Issue } from '@superfield/github';
import {
  projectContextFragment,
  commitStandardsFragment,
  worktreeIsolationFragment,
  joinSections,
} from './fragments/index.ts';

export interface CIFailureContext {
  issue: Issue;
  checkName: string;
  checkRunUrl: string;
  sha: string;
  worktreePath: string;
  branch: string;
}

/**
 * Prompt for a CI remediation agent. Always primary — there is no
 * speculative variant because broken `main` blocks all other work.
 */
export function buildCIFailurePrompt(ctx: CIFailureContext): string {
  return joinSections(
    projectContextFragment(),
    `## Situation

The following CI check is failing on \`main\` and is blocking all development:

- Check: ${ctx.checkName}
- Commit: ${ctx.sha}
- Logs: ${ctx.checkRunUrl}
- Tracking issue: #${ctx.issue.number} — ${ctx.issue.title}
- Branch: ${ctx.branch}

Remediating \`main\` takes absolute priority over any feature work.`,
    worktreeIsolationFragment(ctx.worktreePath),
    `## Your task

1. Read the CI logs at the URL above to understand exactly what is failing.
2. Reproduce the failure locally — run the failing check command in this \
worktree.
3. Identify the root cause. Do not guess; read the error carefully.
4. Apply the smallest correct fix. Do not refactor surrounding code.
5. Verify locally that the fix passes the failing check.
6. Push your fix to the remote branch.
7. Tick off each item in issue #${ctx.issue.number}'s checklist as you go.
8. When the checklist is complete, open a PR as ready for review (never draft).

You are the primary agent for this issue. Do not exit until the PR is merged \
and the issue is CLOSED.

## Rules

- Fix only what is broken. Do not bundle unrelated changes.
- If the root cause is genuinely ambiguous, post a comment on \
issue #${ctx.issue.number} describing what you found before attempting a fix.
- Never bypass CI checks with \`--no-verify\` or by disabling tests. Fix the \
underlying problem.`,
    commitStandardsFragment(),
    `## Begin

\`cd\` into your worktree and start by fetching the CI logs.`,
  );
}
