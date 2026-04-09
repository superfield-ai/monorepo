import { describe, it, expect } from "vitest";
import { buildDevelopIssuePrompt } from "../../prompts/index.ts";
import { replaySpawn } from "../helpers/replay.ts";
import type { Issue } from "@superfield/github";

/**
 * Layer-2 integration test for the dev-loop first-turn narrow blueprint
 * context (#80). The full `tickDevLoop` harness is still TODO; this test
 * exercises the production prompt builder + a replayed Claude response so
 * the fixture parses cleanly through the same wire format the dev-loop
 * uses.
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

describe("dev-loop first turn — narrow context integration", () => {
  it("renders the narrow blueprint fragment and not the expanded fragment", async () => {
    const prompt = buildDevelopIssuePrompt({
      issue,
      role: "primary",
      worktreePath: "/tmp/worktree",
      branch: "issue-10",
      phaseName: "Identity",
    });
    expect(prompt).toContain(NARROW_HEADER);
    expect(prompt).not.toContain(EXPANDED_HEADER);
  });

  it("replays the dev-loop-first-turn fixture and surfaces the escalation flag", async () => {
    const spawn = await replaySpawn("dev-loop-first-turn");
    const result = await spawn({
      prompt: "ignored",
      worktreePath: "/tmp/worktree",
    });
    expect(result.isError).toBe(false);
    expect(result.needsBlueprintEscalation).toBe(true);
    // The fixture output should be parseable as JSON.
    expect(() => JSON.parse(result.output) as unknown).not.toThrow();
  });
});
