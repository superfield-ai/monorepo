import { describe, it } from "vitest";

/**
 * End-to-end dev loop integration test.
 *
 * Goal: drive `tickDevLoop` against MSW for GitHub + a fake worktree root +
 * `replaySpawn` for `claude`. Assert that:
 *   1. The top-of-Plan issue was selected
 *   2. The worktree was created (or reused)
 *   3. A session comment was posted on the issue (deadman switch)
 *   4. The agent was spawned with the correct prompt for the issue's kind
 *   5. The session was updated post-spawn with the real session ID
 *   6. When the agent's run causes the issue to close, the session is deleted
 *
 * Speculative variant: same flow with a phase-mate eligible after scout merge.
 *
 * See docs/testing.md §Layer 2.
 */
describe("dev loop — primary end to end", () => {
  it.todo(
    "selects top of plan, creates worktree, claims slot, spawns develop-issue agent",
  );
  it.todo("uses dev-scout prompt when the selected issue has dev-scout kind");
  it.todo("uses ci-failure prompt when the selected issue has ci-failure kind");
  it.todo("deletes session comment after the issue closes");
  it.todo("reports merge gate blocked when a new predecessor appears before merge");
  it.todo(
    "resumes existing session when a deadman comment is present on startup",
  );
});

describe("dev loop — speculative slots end to end", () => {
  it.todo("opens speculative slot for a phase-mate when scout is closed");
  it.todo("keeps speculative slots empty when scout is still open");
  it.todo("does not pair speculative work with a ci-failure primary");
});
