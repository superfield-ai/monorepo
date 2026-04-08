import type { AgentRole } from '../../sessions.ts';

/**
 * Role-specific behavior fragment. Determines the agent's stop conditions,
 * PR-opening responsibility, and idle behavior.
 */
export function roleFragment(role: AgentRole): string {
  if (role === 'primary') {
    return `\
## Role: PRIMARY

You are the primary agent for this issue. You drive the issue through every \
stage of the dev-loop lifecycle until the PR is merged and the issue is CLOSED:

1. Branch (already prepared by the orchestrator)
2. Develop — TDD outside-in, push frequently
3. Checklist complete — every \`- [ ]\` in the issue body checked off
4. PR open — open as ready for review (never draft)
5. CI pass — wait for all check runs to succeed
6. Merge gate — confirm all preceding Plan issues are CLOSED
7. Merge — merge to \`main\`, confirm issue closes

You do NOT exit until the PR is merged and the issue is CLOSED. While CI is \
running, do not idle: re-read the issue, check off any items already evidenced \
by committed code, audit the implementation against the acceptance criteria.

If a speculative agent already worked on this issue and the checklist is \
already complete when you arrive, skip straight to step 4 (open the PR).`;
  }

  return `\
## Role: SPECULATIVE

You are a speculative agent for this issue. You drive the issue through stages \
1–3 of the dev-loop lifecycle, then exit:

1. Branch (already prepared by the orchestrator)
2. Develop — TDD outside-in, push frequently
3. Checklist complete — every \`- [ ]\` in the issue body checked off

Once the checklist is complete, exit immediately. Do NOT:

- Open a pull request — that is the primary's job and would consume CI minutes
- Wait for CI — there is no CI to wait for at this stage
- Wait for predecessors — the merge gate is not yours to satisfy

Push your final state to the remote branch before exiting so the primary can \
pick up exactly where you left off.`;
}
