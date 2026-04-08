import { describe, it, expect, vi } from "vitest";
import { runBlueprintConformance } from "../../steps/blueprint-conformance.ts";
import type { Blueprint } from "../../blueprint.ts";
import type { GitHubClient, Issue } from "@superfield/github";
import type { AgentOpts, AgentResult } from "../../agent.ts";

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
    listIssues: vi.fn().mockResolvedValue([]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

function fakeSpawn(responses: unknown[]) {
  let idx = 0;
  return async (_opts: AgentOpts): Promise<AgentResult> => ({
    sessionId: `sess-${idx}`,
    output: JSON.stringify(responses[idx++] ?? responses[responses.length - 1]),
    isError: false,
  });
}

const emptyBlueprint: Blueprint = {
  corpusVersion: 1,
  generated: "2026-01-01",
  ruleCount: 0,
  nodes: [],
  domains: new Map(),
};

describe("runBlueprintConformance", () => {
  it("returns empty result when no candidates", async () => {
    const client = makeClient();
    const result = await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn: fakeSpawn([{ issue_number: 10, violations: [] }]),
    });
    expect(result.checked).toBe(0);
    expect(result.issuesWithViolations).toEqual([]);
  });

  it("checks candidate issues and reports no violations cleanly", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    const result = await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn: fakeSpawn([{ issue_number: 10, violations: [] }]),
    });
    expect(result.checked).toBe(1);
    expect(result.issuesWithViolations).toEqual([]);
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it("posts advisory comment when violations exist", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    const violation = {
      rule_id: "ARCH-P-001",
      rule_name: "boundaries-are-physical-not-conceptual",
      rule_type: "principle",
      domain: "arch",
      concern: "This refactor blurs the server/client boundary.",
    };
    const result = await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn: fakeSpawn([{ issue_number: 10, violations: [violation] }]),
    });
    expect(result.issuesWithViolations).toEqual([10]);
    expect(client.createIssueComment).toHaveBeenCalledTimes(1);
    const body = (client.createIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]![3] as string;
    expect(body).toContain("<!-- superfield-blueprint -->");
    expect(body).toContain("ARCH-P-001");
    expect(body).toContain("blurs the server/client boundary");
  });

  it("updates existing advisory comment instead of duplicating", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
      listIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 777, body: "<!-- superfield-blueprint -->\nold content" },
        ]),
    });
    const violation = {
      rule_id: "ARCH-P-001",
      rule_name: "boundaries",
      rule_type: "principle",
      domain: "arch",
      concern: "new concern",
    };
    await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn: fakeSpawn([{ issue_number: 10, violations: [violation] }]),
    });
    expect(client.updateIssueComment).toHaveBeenCalledWith(
      "org",
      "repo",
      777,
      expect.any(String),
    );
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it("deletes stale advisory comment when issue has no violations", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
      listIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 500, body: "<!-- superfield-blueprint -->\nstale advisory" },
        ]),
    });
    await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn: fakeSpawn([{ issue_number: 10, violations: [] }]),
    });
    expect(client.deleteIssueComment).toHaveBeenCalledWith("org", "repo", 500);
  });

  it("skips issues with no candidate domains without spawning LLM", async () => {
    const spawn = vi.fn();
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ number: 10, title: "foo", body: "bar" }),
        ]),
    });
    await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn: spawn as unknown as (opts: AgentOpts) => Promise<AgentResult>,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("skips plan and ci-failure labelled issues", async () => {
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ number: 10 }),
          makeIssue({ number: 99, labels: ["plan"] }),
          makeIssue({ number: 50, labels: ["ci-failure"] }),
        ]),
    });
    const result = await runBlueprintConformance(client, "org", "repo", {
      blueprint: emptyBlueprint,
      spawn: fakeSpawn([{ issue_number: 10, violations: [] }]),
    });
    expect(result.checked).toBe(1);
  });
});
