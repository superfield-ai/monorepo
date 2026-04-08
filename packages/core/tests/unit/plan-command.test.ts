import { describe, it, expect, vi } from "vitest";
import { collectPlanInputs, runPlanCommand } from "../../commands/plan.ts";
import type { GitHubClient, Issue } from "@superfield/github";
import type { AgentOpts, AgentResult } from "../../agent.ts";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 10,
    title: "feat: example",
    body: "## Phase\nIdentity\n\n## Motivation\nbecause\n\n## Features\n- [ ] x\n\n## Test Plan\n- [ ] y",
    html_url: "",
    state: "open",
    labels: [],
    ...overrides,
  };
}

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue({ number: 1000 }),
    updateIssueBody: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

function fakeSpawn(response: unknown) {
  return async (_opts: AgentOpts): Promise<AgentResult> => ({
    sessionId: "sess",
    output: JSON.stringify(response),
    isError: false,
  });
}

const validProposal = {
  phases: [
    {
      name: "Identity",
      goal: "Build the auth seams",
      depends_on: [],
      scout_issue_number: 5,
      issue_numbers: [5, 10],
    },
  ],
  ordered_issues: [
    {
      number: 5,
      title: "chore: scout identity",
      phase: "Identity",
      kind: "dev-scout",
      risk: 5,
      dependencies: [],
      dependents: [10],
      parallel_safe: true,
    },
    {
      number: 10,
      title: "feat: build auth",
      phase: "Identity",
      kind: "feature",
      risk: 4,
      dependencies: [5],
      dependents: [],
      parallel_safe: false,
    },
  ],
  scout_specs: [],
};

describe("runPlanCommand", () => {
  it("collectPlanInputs separates plan issues from planning candidates", () => {
    const inputs = collectPlanInputs([
      makeIssue({ number: 99, title: "Plan", labels: ["plan"] }),
      makeIssue({
        number: 50,
        title: "fix: ci failure",
        labels: ["ci-failure"],
      }),
      makeIssue({ number: 10, title: "feat: example" }),
    ]);

    expect(inputs.planIssues.map((issue) => issue.number)).toEqual([99]);
    expect(inputs.candidates.map((issue) => issue.number)).toEqual([10]);
  });

  it("returns empty result when no candidate issues", async () => {
    const client = makeClient();
    const result = await runPlanCommand({
      client,
      owner: "o",
      repo: "r",
      spawn: fakeSpawn(validProposal),
    });
    expect(result.planUpdated).toBe(false);
    expect(result.planCreated).toBe(false);
    expect(result.scoutsCreated).toEqual([]);
  });

  it("creates Plan tracking issue on first run", async () => {
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ number: 5, labels: ["dev-scout"] }),
          makeIssue({ number: 10 }),
        ]),
    });
    const result = await runPlanCommand({
      client,
      owner: "o",
      repo: "r",
      spawn: fakeSpawn(validProposal),
    });
    expect(result.planCreated).toBe(true);
    expect(result.validationErrors).toEqual([]);
    expect(client.createIssue).toHaveBeenCalled();
    const planCall = (
      client.createIssue as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0].labels?.includes("plan"));
    expect(planCall).toBeDefined();
    expect(planCall![0].body).toContain("## Phase: Identity");
    expect(planCall![0].body).toContain("#5");
    expect(planCall![0].body).toContain("#10");
  });

  it("updates existing Plan issue", async () => {
    const planIssue = makeIssue({
      number: 99,
      labels: ["plan"],
      body: "old plan",
    });
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          planIssue,
          makeIssue({ number: 5, labels: ["dev-scout"] }),
          makeIssue({ number: 10 }),
        ]),
    });
    const result = await runPlanCommand({
      client,
      owner: "o",
      repo: "r",
      spawn: fakeSpawn(validProposal),
    });
    expect(result.planUpdated).toBe(true);
    expect(result.planCreated).toBe(false);
    expect(client.updateIssueBody).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 99,
      body: expect.stringContaining("## Phase: Identity"),
    });
  });

  it("creates scout issues from null-numbered scout_specs", async () => {
    const proposal = {
      phases: [
        {
          name: "Identity",
          goal: "Build the auth seams",
          depends_on: [],
          scout_issue_number: null,
          issue_numbers: [10],
        },
      ],
      ordered_issues: [
        {
          number: null,
          title: "chore: scout identity",
          phase: "Identity",
          kind: "dev-scout",
          risk: 5,
          dependencies: [],
          parallel_safe: true,
          scout_spec_index: 0,
        },
        {
          number: 10,
          title: "feat: build auth",
          phase: "Identity",
          kind: "feature",
          risk: 4,
          dependencies: [],
          parallel_safe: false,
        },
      ],
      scout_specs: [
        {
          title: "chore: scout identity",
          phase: "Identity",
          motivation: "because",
          features: ["Stub auth interfaces"],
          test_plan: ["Compile passes"],
          canonical_docs: ["docs/prd.md"],
        },
      ],
    };

    let createCallCount = 0;
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 10 })]),
      createIssue: vi
        .fn()
        .mockImplementation(async (params: { labels?: string[] }) => {
          createCallCount++;
          if (params.labels?.includes("dev-scout")) {
            return { number: 555, title: "chore: scout identity" };
          }
          return { number: 99, title: "Plan" };
        }),
    });
    const result = await runPlanCommand({
      client,
      owner: "o",
      repo: "r",
      spawn: fakeSpawn(proposal),
    });
    expect(result.scoutsCreated).toEqual([555]);
    expect(result.validationErrors).toEqual([]);
    expect(createCallCount).toBe(2); // scout + plan
  });

  it("reports validation errors for duplicate issue numbers", async () => {
    const proposal = {
      phases: [
        {
          name: "P",
          goal: "",
          depends_on: [],
          scout_issue_number: 1,
          issue_numbers: [1, 2],
        },
      ],
      ordered_issues: [
        {
          number: 1,
          title: "s",
          phase: "P",
          kind: "dev-scout",
          risk: 5,
          dependencies: [],
          parallel_safe: true,
        },
        {
          number: 1,
          title: "f",
          phase: "P",
          kind: "feature",
          risk: 3,
          dependencies: [],
          parallel_safe: false,
        },
      ],
      scout_specs: [],
    };
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ number: 1 }),
          makeIssue({ number: 2 }),
        ]),
    });
    const result = await runPlanCommand({
      client,
      owner: "o",
      repo: "r",
      spawn: fakeSpawn(proposal),
    });
    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.validationErrors.join(" ")).toContain("duplicate");
    expect(result.planCreated).toBe(false);
  });

  it("reports validation errors for phase with no scout", async () => {
    const proposal = {
      phases: [
        {
          name: "P",
          goal: "",
          depends_on: [],
          scout_issue_number: 1,
          issue_numbers: [1],
        },
      ],
      ordered_issues: [
        {
          number: 1,
          title: "f",
          phase: "P",
          kind: "feature",
          risk: 3,
          dependencies: [],
          parallel_safe: true,
        },
      ],
      scout_specs: [],
    };
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 1 })]),
    });
    const result = await runPlanCommand({
      client,
      owner: "o",
      repo: "r",
      spawn: fakeSpawn(proposal),
    });
    expect(result.validationErrors.join(" ")).toContain("no dev-scout");
  });

  it("reports validation errors for phase dependency cycles", async () => {
    const proposal = {
      phases: [
        {
          name: "A",
          goal: "",
          depends_on: ["B"],
          scout_issue_number: 1,
          issue_numbers: [1],
        },
        {
          name: "B",
          goal: "",
          depends_on: ["A"],
          scout_issue_number: 2,
          issue_numbers: [2],
        },
      ],
      ordered_issues: [
        {
          number: 1,
          title: "s",
          phase: "A",
          kind: "dev-scout",
          risk: 5,
          dependencies: [],
          parallel_safe: true,
        },
        {
          number: 2,
          title: "s",
          phase: "B",
          kind: "dev-scout",
          risk: 5,
          dependencies: [],
          parallel_safe: true,
        },
      ],
      scout_specs: [],
    };
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ number: 1 }),
          makeIssue({ number: 2 }),
        ]),
    });
    const result = await runPlanCommand({
      client,
      owner: "o",
      repo: "r",
      spawn: fakeSpawn(proposal),
    });
    expect(result.validationErrors.join(" ")).toContain("cycle");
  });

  it.todo("runs the documented audit stage before applying plan coverage");
});
