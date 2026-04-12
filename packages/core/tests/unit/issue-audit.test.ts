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
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    updateIssueBody: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

const conformantBatchResponse = {
  reports: [
    {
      issue_number: 10,
      conformant: true,
      missing_sections: [],
      forbidden_sections: [],
      empty_sections: [],
      quality_issues: [],
    },
  ],
};

const nonConformantBatchResponse = {
  reports: [
    {
      issue_number: 10,
      conformant: false,
      missing_sections: ["## Features"],
      forbidden_sections: ["## Deliverables"],
      empty_sections: [],
      quality_issues: ["Test plan item 1 is vague"],
      proposed_body:
        "## Phase\nFoundation\n\n## Motivation\nBecause.\n\n## Canonical docs\n- docs/prd.md\n\n## Features\n- [ ] Replace Deliverables with scoped features\n\n## Test Plan\n- [ ] Add a targeted assertion",
    },
  ],
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
      spawn: fakeSpawn(conformantBatchResponse),
    });
    expect(result.audited).toBe(0);
    expect(result.nonConformant).toEqual([]);
  });

  it("audits each candidate issue and collects conformant reports", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    const result = await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn(conformantBatchResponse),
    });
    expect(result.audited).toBe(1);
    expect(result.nonConformant).toEqual([]);
    expect(result.reports[10]?.conformant).toBe(true);
    expect(client.updateIssueBody).not.toHaveBeenCalled();
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it("rewrites non-conformant issue bodies and applies the label", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([
        makeIssue({
          number: 10,
          body: "## Motivation\nBecause.",
        }),
      ]),
    });
    const result = await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn(nonConformantBatchResponse),
    });
    expect(result.nonConformant).toEqual([10]);
    expect(client.updateIssueBody).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      body: nonConformantBatchResponse.reports[0]!.proposed_body,
    });
    expect(client.addIssueLabel).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      label: "non-conformant",
    });
    expect(result.reports[10]?.quality_issues).toEqual([
      "Test plan item 1 is vague",
    ]);
  });

  it("deletes stale audit findings and removes stale label when conformant", async () => {
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
      spawn: fakeSpawn(conformantBatchResponse),
    });
    expect(client.removeIssueLabel).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      label: "non-conformant",
    });
    expect(client.deleteIssueComment).toHaveBeenCalledWith("org", "repo", 500);
    expect(client.updateIssueBody).not.toHaveBeenCalled();
    expect(client.updateIssueComment).not.toHaveBeenCalled();
    expect(client.createIssueComment).not.toHaveBeenCalled();
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
      spawn: async (_opts: AgentOpts): Promise<AgentResult> => ({
        sessionId: "sess-1",
        output: JSON.stringify({
          reports: [
            {
              issue_number: 10,
              conformant: true,
              missing_sections: [],
              forbidden_sections: [],
              empty_sections: [],
              quality_issues: [],
            },
            {
              issue_number: 22,
              conformant: true,
              missing_sections: [],
              forbidden_sections: [],
              empty_sections: [],
              quality_issues: [],
            },
          ],
        }),
        isError: false,
      }),
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

  it("normalizes malformed audit arrays before applying remediation", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([
        makeIssue({ number: 10, body: "bad body" }),
      ]),
    });
    const result = await runIssueAudit(client, "org", "repo", {
      spawn: fakeSpawn({
        reports: [
          {
            issue_number: 10,
            conformant: false,
            missing_sections: ["## Features", 123, null],
            forbidden_sections: "bad",
            empty_sections: undefined,
            quality_issues: ["Rewrite tests", false],
            proposed_body: "## Phase\nFoundation",
          },
        ],
      }),
    });

    expect(result.reports[10]?.missing_sections).toEqual(["## Features"]);
    expect(result.reports[10]?.forbidden_sections).toEqual([]);
    expect(result.reports[10]?.quality_issues).toEqual(["Rewrite tests"]);
    expect(client.updateIssueBody).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      body: "## Phase\nFoundation",
    });
  });

  it("throws when a non-conformant issue is missing proposed_body", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    await expect(
      runIssueAudit(client, "org", "repo", {
        spawn: fakeSpawn({
          reports: [
            {
              issue_number: 10,
              conformant: false,
              missing_sections: ["## Phase"],
              forbidden_sections: [],
              empty_sections: [],
              quality_issues: [],
            },
          ],
        }),
      }),
    ).rejects.toThrow(/without proposed_body/);
  });

  it("throws when the batch response is missing required reports", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
    });
    await expect(
      runIssueAudit(client, "org", "repo", {
        spawn: fakeSpawn({ some: "bad" }),
      }),
    ).rejects.toThrow(/missing reports/);
  });

  it("throws when the batch response omits an input issue", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([
        makeIssue({ number: 10 }),
        makeIssue({ number: 11 }),
      ]),
    });
    await expect(
      runIssueAudit(client, "org", "repo", {
        spawn: fakeSpawn({
          reports: [
            {
              issue_number: 10,
              conformant: true,
              missing_sections: [],
              forbidden_sections: [],
              empty_sections: [],
              quality_issues: [],
            },
          ],
        }),
      }),
    ).rejects.toThrow(/reports length mismatch|missing report/);
  });
});
