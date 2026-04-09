import { describe, it, expect, vi } from "vitest";
import { runBlueprintConformance } from "../../steps/blueprint-conformance.ts";
import { replaySpawn } from "../helpers/replay.ts";
import type { Blueprint } from "../../blueprint.ts";
import type { GitHubClient, Issue } from "@superfield/github";

/**
 * Layer-2 integration tests for the planning-loop blueprint conformance step.
 * Drives the production `runBlueprintConformance` entrypoint with hand-authored
 * Claude fixtures replayed via `replaySpawn` (see `docs/testing.md` §Layer 2).
 */

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 10,
    title: "feat: architecture refactor of package boundaries",
    body: "Split monorepo into clearer package boundaries.",
    html_url: "https://github.com/x/y/issues/10",
    state: "open",
    labels: [],
    ...overrides,
  };
}

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: vi.fn().mockResolvedValue([makeIssue()]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

const emptyBlueprint: Blueprint = {
  corpusVersion: 1,
  generated: "2026-04-09",
  ruleCount: 0,
  nodes: [],
  domains: new Map(),
};

describe("runBlueprintConformance — replaySpawn integration", () => {
  it("records zero violations when the conformant fixture is replayed", async () => {
    const client = makeClient();
    const spawn = await replaySpawn("blueprint-conformance-conformant");

    const result = await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn,
    });

    expect(result.checked).toBe(1);
    expect(result.issuesWithViolations).toEqual([]);
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it("posts a single advisory comment carrying the rule id when the violating fixture is replayed", async () => {
    const client = makeClient();
    const spawn = await replaySpawn("blueprint-conformance-violating");

    const result = await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn,
    });

    expect(result.issuesWithViolations).toEqual([10]);
    expect(client.createIssueComment).toHaveBeenCalledTimes(1);
    const body = (client.createIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]![3] as string;
    expect(body).toContain("<!-- superfield-blueprint -->");
    expect(body).toContain("ARCH-P-001");
  });
});
