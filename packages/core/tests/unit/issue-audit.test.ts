import { describe, it, expect, vi } from "vitest";
import { listAuditableIssues, runIssueAudit } from "../../steps/issue-audit.ts";
import type { GitHubClient, Issue } from "@superfield/github";
import type { AgentOpts, AgentResult } from "../../agent.ts";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 10,
    title: "feat: example",
    body: null,
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
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

const conformantResponse = {
  issue_number: 10,
  conformant: true,
  missing_sections: [],
  forbidden_sections: [],
  empty_sections: [],
  fix_suggestions: [],
};

const nonConformantResponse = {
  issue_number: 10,
  conformant: false,
  missing_sections: ["## Features"],
  forbidden_sections: ["## Deliverables"],
  empty_sections: [],
  fix_suggestions: ["Rename Deliverables to Features"],
};

function fakeSpawn(response: unknown) {
  return async (_opts: AgentOpts): Promise<AgentResult> => ({
    sessionId: "sess-1",
    output: JSON.stringify(response),
    isError: false,
  });
}

describe("runIssueAudit", () => {
  it("returns empty result when no candidate issues", async () => {
    const client = makeClient();
    const result = await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn(conformantResponse),
    });
    expect(result.audited).toBe(0);
    expect(result.nonConformant).toEqual([]);
  });

  it("audits each candidate issue and collects conformant reports", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    const result = await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn(conformantResponse),
    });
    expect(result.audited).toBe(1);
    expect(result.nonConformant).toEqual([]);
    expect(result.reports[10]?.conformant).toBe(true);
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it("posts findings comment on non-conformant issues", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    const result = await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn(nonConformantResponse),
    });
    expect(result.nonConformant).toEqual([10]);
    expect(client.createIssueComment).toHaveBeenCalledTimes(1);
    const body = (client.createIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]![3] as string;
    expect(body).toContain("<!-- superfield-audit -->");
    expect(body).toContain("## Features");
    expect(body).toContain("## Deliverables");
    expect(body).toContain("Rename Deliverables to Features");
    expect(client.addIssueLabel).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      label: "non-conformant",
    });
  });

  it("updates existing audit comment and removes stale label when conformant", async () => {
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ number: 10, labels: ["non-conformant"] }),
        ]),
      listIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 500, body: "<!-- superfield-audit -->\nold content" },
        ]),
    });
    await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn(conformantResponse),
    });
    expect(client.removeIssueLabel).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      label: "non-conformant",
    });
    expect(client.updateIssueComment).not.toHaveBeenCalled();
  });

  it("skips plan and ci-failure labelled issues", async () => {
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ number: 10 }),
          makeIssue({ number: 20, labels: ["plan"] }),
          makeIssue({ number: 21, labels: ["ci-failure"] }),
          makeIssue({ number: 22, labels: ["non-conformant"] }),
        ]),
    });
    const result = await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn(conformantResponse),
    });
    expect(result.audited).toBe(2);
  });

  it("listAuditableIssues returns only schema-auditable issues", () => {
    const auditable = listAuditableIssues([
      makeIssue({ number: 10 }),
      makeIssue({ number: 20, labels: ["plan"] }),
      makeIssue({ number: 21, labels: ["ci-failure"] }),
      makeIssue({ number: 22, labels: ["non-conformant"] }),
    ]);

    expect(auditable.map((issue) => issue.number)).toEqual([10, 22]);
  });

  it("normalizes malformed audit arrays before posting findings", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    const result = await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn({
        issue_number: 10,
        conformant: false,
        missing_sections: ["## Features", 123, null],
        forbidden_sections: "bad",
        empty_sections: undefined,
        fix_suggestions: ["Rename Deliverables", false],
      }),
    });

    expect(result.reports[10]?.missing_sections).toEqual(["## Features"]);
    expect(result.reports[10]?.forbidden_sections).toEqual([]);
    expect(result.reports[10]?.fix_suggestions).toEqual([
      "Rename Deliverables",
    ]);
    const body = (client.createIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]![3] as string;
    expect(body).toContain("## Features");
    expect(body).toContain("Rename Deliverables");
    expect(body).not.toContain("123");
  });

  it("throws when LLM response is missing required fields", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    await expect(
      runIssueAudit(client, "org", "repo", {
        spawn: fakeSpawn({ some: "bad" }),
      }),
    ).rejects.toThrow(/missing issue_number/);
  });
});
