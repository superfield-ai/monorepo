import { describe, it, expect, vi } from "vitest";
import { runIssueAudit } from "../../steps/issue-audit.ts";
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
  });

  it("updates existing audit comment instead of creating duplicate", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
      listIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 500, body: "<!-- superfield-audit -->\nold content" },
        ]),
    });
    await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn(nonConformantResponse),
    });
    expect(client.updateIssueComment).toHaveBeenCalledWith(
      "org",
      "repo",
      500,
      expect.any(String),
    );
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it("skips plan, ci-failure, and non-conformant labelled issues", async () => {
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
    expect(result.audited).toBe(1);
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

  it.todo("applies the non-conformant label when audit finds violations");
});
