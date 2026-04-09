import { describe, it, expect, vi } from "vitest";
import { runFeatureCommand } from "../../commands/feature.ts";
import { replaySpawnSequence } from "../helpers/replay.ts";
import type { GitHubClient } from "@superfield/github";

/**
 * Layer-2 integration test for the principles-first `feature` command (#83).
 * Drives `runFeatureCommand` end-to-end with a sequenced replay of the
 * exploratory and narrowing fixtures.
 */

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    createIssue: vi
      .fn()
      .mockResolvedValue({ number: 100, title: "feat: add logout button" }),
    updateIssueBody: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

describe("runFeatureCommand — replaySpawn integration", () => {
  it("creates one issue when sequencing exploratory + narrowed fixtures", async () => {
    const client = makeClient();
    const spawn = await replaySpawnSequence([
      "feature-evaluate-exploratory",
      "feature-evaluate-narrowed",
    ]);

    const result = await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "Add a logout button to the navbar that clears the session",
      spawn,
    });

    expect(result.duplicateOf).toBeNull();
    expect(result.outOfScope).toBe(false);
    expect(result.issueCreated).toBe(100);
    expect(client.createIssue).toHaveBeenCalled();
    // First createIssue call is the feature issue, second (if any) is the Plan
    const featureCall = (client.createIssue as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { title: string; body: string };
    expect(featureCall.title).toBe("feat: add logout button to navbar");
    expect(featureCall.body).toContain("Identity");
  });

  it("skips narrowing and creates no issue when the duplicate fixture is replayed", async () => {
    const client = makeClient();
    const spawn = await replaySpawnSequence(["feature-evaluate-duplicate"]);

    const result = await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "Add a logout button",
      spawn,
    });

    expect(result.duplicateOf).toBe(42);
    expect(result.issueCreated).toBeNull();
    expect(client.createIssue).not.toHaveBeenCalled();
  });
});
