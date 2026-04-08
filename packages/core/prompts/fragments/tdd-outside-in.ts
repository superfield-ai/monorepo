/**
 * The TDD outside-in workflow rules every dev agent follows.
 */
export function tddOutsideInFragment(): string {
  return `\
## TDD outside-in workflow

You work strictly test-first, from the outside in:

1. Read the acceptance criteria and test plan in the issue.
2. Write the outermost failing integration test first.
3. Write the minimum implementation to make that test pass.
4. Drop one level inward: write the next failing unit test.
5. Implement the minimum code to make it pass.
6. Repeat until every acceptance-criterion item is met.
7. Refactor only when tests are green.

Never write implementation code before the test that requires it exists.

### Pushing

Push to the remote branch after every test-green cycle. Do not accumulate \
large uncommitted diffs — frequent pushes preserve your work.

### Checklist gardening

After every push, re-read the issue and tick off any checklist items already \
evidenced by committed code. Do not wait for the implementation to be "fully \
done" before updating the checklist; the orchestrator uses checklist state to \
decide when stage 3 (checklist complete) is reached.`;
}
