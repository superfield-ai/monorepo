import { describe, it } from "vitest";

/**
 * End-to-end documentation loop integration test.
 *
 * Goal: drive `tickDocLoop` against MSW for GitHub + a temp repo dir
 * containing PRD/README + recorded fixtures for the three doc tasks.
 * Assert that:
 *   1. A merged PR newer than the watermark is detected
 *   2. Coverage scan runs only over .ts source files (not tests/)
 *   3. Canonical sync emits patches when the PR adds a new command
 *   4. Consistency check emits findings when canonical and inline drift
 *   5. A docs/auto-N branch is created and patches are applied via Contents API
 *   6. A doc PR is opened with all proposed changes
 *   7. No PR is opened when no patches matched their old_text
 *
 * See docs/testing.md §Layer 2.
 */
describe("doc loop — end to end", () => {
  it.todo("detects newly merged PR after the watermark");
  it.todo("runs all three doc tasks in parallel");
  it.todo("opens a doc PR when canonical sync produces patches");
  it.todo("skips PR when no patches matched the file content");
  it.todo("skips coverage and consistency tasks when PR has no source files");
  it.todo(
    "respects CI gating: doc-only changes do not trigger build/test workflows",
  );
});
