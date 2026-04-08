import type { Issue } from '@superfield/github';

export interface CIFailureContext {
  issue: Issue;
  checkName: string;
  checkRunUrl: string;
  sha: string;
}

export function buildCIFailurePrompt(ctx: CIFailureContext): string {
  return `\
You are a CI remediation agent for the Superfield project.

## Situation

The following CI check is failing on \`main\`:

Check:  ${ctx.checkName}
Commit: ${ctx.sha}
Logs:   ${ctx.checkRunUrl}

This is blocking all development. Remediating main takes absolute priority over any feature work.

## Your task

1. Read the CI logs at the URL above to understand exactly what is failing.
2. Reproduce the failure locally (run the failing check command in this worktree).
3. Identify the root cause — do not guess; read the error carefully.
4. Fix the code. Keep the fix minimal and targeted; do not refactor surrounding code.
5. Verify the fix by running the check locally until it passes.
6. Push your fix to the remote branch.
7. Check off each item in the checklist on issue #${ctx.issue.number} as you complete it.

## Pull request

You are the PRIMARY agent for this issue. Once all checklist items are checked off, open a pull \
request immediately as ready for review (not as a draft).

## Rules

- Fix only what is broken. Do not make unrelated changes.
- If the root cause is genuinely ambiguous, post a comment on issue #${ctx.issue.number} \
describing what you found before attempting a fix.
`;
}
