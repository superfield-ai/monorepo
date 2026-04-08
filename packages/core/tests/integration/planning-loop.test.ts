import { describe, it } from 'vitest';

/**
 * End-to-end planning loop integration test.
 *
 * Goal: spin up `tickPlanningLoop` (or the equivalent) once against MSW
 * for the GitHub API and a `replaySpawn` for the LLM, then assert that:
 *   1. CI watchdog detected the failed check
 *   2. ci-failure issue was created and inserted at top of Plan
 *   3. plan-coverage appended a new open issue to the Plan
 *   4. issue-audit posted a comment on a non-conformant issue
 *   5. blueprint-conformance posted a comment with a rule ID
 *
 * See docs/testing.md §Layer 2.
 */
describe('planning loop — end to end', () => {
  it.todo('CI watchdog detects failed check and inserts ci-failure at top of Plan');
  it.todo('plan-coverage appends a new open issue to the Plan');
  it.todo('issue-audit posts a non-conformant comment when sections are missing');
  it.todo('blueprint-conformance posts an advisory comment citing a rule ID');
  it.todo('multiple steps composing one tick produce the expected forge state');
});
