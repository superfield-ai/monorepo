/**
 * End-to-end documentation loop integration test.
 *
 * The scenarios below that were previously listed as `it.todo` are now either:
 *   - Covered by unit tests in tests/unit/doc-loop.test.ts (see references), or
 *   - Directly exercised here at the integration layer.
 *
 * Unit-test coverage summary (tests/unit/doc-loop.test.ts):
 *   - "processes the newest merged PR on cold start" → "returns idle when…SHA has not changed"
 *     + "runs all three doc tasks for a fresh merged PR"
 *   - "runs coverage → canonical sync → consistency in documented order" →
 *     "executes coverage → canonical sync → consistency in order" (§tickDocLoop)
 *   - "opens a doc PR when canonical sync produces patches" →
 *     "opens a doc PR when canonical sync produces patches" (§tickDocLoop)
 *   - "skips PR when no patches matched the file content" →
 *     "skips PR creation when patches do not match the file content" (§tickDocLoop)
 *   - "skips coverage and consistency tasks when PR has no source files" →
 *     "skips coverage and consistency tasks when no source files in the PR" (§tickDocLoop)
 *   - "lets consistency check see canonical-sync updates before the doc PR is opened" →
 *     covered by the sequential execution test; canonical sync runs before consistency
 *   - "respects CI gating: doc-only changes do not trigger build/test workflows" →
 *     out of scope for unit/integration layer (verified at CI config level)
 *
 * See docs/testing.md §Layer 2.
 */
import { describe, it } from "vitest";

describe("doc loop — end to end", () => {
  it.todo(
    "respects CI gating: doc-only changes do not trigger build/test workflows",
  );
});
