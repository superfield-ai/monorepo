import { describe, it, expect } from "vitest";
import { buildDevelopIssuePrompt } from "../../prompts/index.ts";
import { replaySpawnSequence } from "../helpers/replay.ts";
import type { Issue } from "@superfield/github";

/**
 * Layer-2 integration test for the dev-loop blueprint escalation latch (#78).
 * Models the two-turn handoff: first turn rendered without `escalated`, the
 * agent's reply (replayed from the `dev-loop-first-turn` fixture) sets
 * `needsBlueprintEscalation: true`, and the next turn is rendered with
 * `escalated: true` so principles + threats are layered on.
 */

const issue: Issue = {
  number: 10,
  title: "feat: refresh OAuth session token before expiry",
  body: "When the auth session is about to expire, refresh it transparently.",
  html_url: "https://github.com/x/y/issues/10",
  state: "open",
  labels: [],
};

const NARROW_HEADER = "## Blueprint rules (narrow context — first pass)";
const EXPANDED_HEADER = "## Blueprint rules (expanded context — escalation)";

describe("dev-loop blueprint escalation — sequenced replay integration", () => {
  it("escalates from narrow to expanded context after needsBlueprintEscalation latches", async () => {
    const spawn = await replaySpawnSequence([
      "dev-loop-first-turn",
      "dev-loop-escalated",
    ]);

    // Turn 1 — narrow context only.
    const firstPrompt = buildDevelopIssuePrompt({
      issue,
      role: "primary",
      worktreePath: "/tmp/worktree",
      branch: "issue-10",
      phaseName: "Identity",
    });
    expect(firstPrompt).toContain(NARROW_HEADER);
    expect(firstPrompt).not.toContain(EXPANDED_HEADER);

    const firstResult = await spawn({
      prompt: firstPrompt,
      worktreePath: "/tmp/worktree",
    });
    expect(firstResult.needsBlueprintEscalation).toBe(true);

    // Turn 2 — dev-loop latches the escalation and re-renders with the
    // expanded fragment layered on top of the narrow one.
    const escalated =
      firstResult.needsBlueprintEscalation === true ? true : false;
    const secondPrompt = buildDevelopIssuePrompt({
      issue,
      role: "primary",
      worktreePath: "/tmp/worktree",
      branch: "issue-10",
      phaseName: "Identity",
      escalated,
    });
    expect(secondPrompt).toContain(NARROW_HEADER);
    expect(secondPrompt).toContain(EXPANDED_HEADER);

    const secondResult = await spawn({
      prompt: secondPrompt,
      worktreePath: "/tmp/worktree",
    });
    expect(secondResult.isError).toBe(false);
    // Second fixture should not retrigger escalation (one-shot latch).
    expect(secondResult.needsBlueprintEscalation).toBe(false);
  });
});
