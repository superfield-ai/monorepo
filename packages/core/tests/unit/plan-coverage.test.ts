import { describe, it, expect, vi } from "vitest";
import { runPlanCoverage } from "../../steps/plan-coverage.ts";
import type { GitHubClient, Issue } from "@superfield/github";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 100,
    title: "feat: example",
    body: null,
    html_url: "https://github.com/x/y/issues/100",
    state: "open",
    labels: [],
    ...overrides,
  };
}

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: vi.fn(),
    createIssue: vi.fn(),
    updateIssueBody: vi.fn(),
    ...overrides,
  } as unknown as GitHubClient;
}

describe("runPlanCoverage", () => {
  it("creates the Plan issue on first run when open issues exist", async () => {
    const issues = [makeIssue({ number: 10, title: "feat: one" })];
    const client = makeClient({
      listIssues: vi.fn(async (_o, _r, labels?: string[]) => {
        if (labels?.includes("plan")) return [];
        return issues;
      }) as unknown as GitHubClient["listIssues"],
      createIssue: vi.fn().mockResolvedValue({ number: 99, title: "Plan" }),
    });

    const result = await runPlanCoverage(client, "org", "repo");

    expect(result.planCreated).toBe(true);
    expect(result.appended).toEqual([10]);
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const createArg = (client.createIssue as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(createArg.title).toBe("Plan");
    expect(createArg.labels).toContain("plan");
    expect(createArg.body).toContain("#10");
    expect(createArg.body).toContain("<!-- superfield:");
  });

  it("appends only missing issues when Plan already exists", async () => {
    const existingPlanBody = `## Phase: Backlog

Goal:
Depends on phases: None.
Scout gate: pending

- #10 — feat: one [risk: 3]
  <!-- superfield: {"number":10,"title":"feat: one","phase":"Backlog","kind":"feature","risk":3,"dependencies":[],"parallel_safe":true} -->
`;
    const planIssue = {
      number: 99,
      title: "Plan",
      body: existingPlanBody,
      labels: ["plan"],
      state: "open",
      html_url: "",
    };
    const openIssues = [
      makeIssue({ number: 10, title: "feat: one" }),
      makeIssue({ number: 11, title: "feat: two" }),
    ];
    const client = makeClient({
      listIssues: vi.fn(async (_o, _r, labels?: string[]) => {
        if (labels?.includes("plan")) return [planIssue];
        return openIssues;
      }) as unknown as GitHubClient["listIssues"],
      updateIssueBody: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPlanCoverage(client, "org", "repo");

    expect(result.planCreated).toBe(false);
    expect(result.appended).toEqual([11]);
    expect(result.alreadyCovered).toEqual([10]);
    expect(client.updateIssueBody).toHaveBeenCalledTimes(1);
    const body = (client.updateIssueBody as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].body;
    expect(body).toContain("#10");
    expect(body).toContain("#11");
  });

  it("skips ci-failure and plan-labelled issues", async () => {
    const openIssues = [
      makeIssue({ number: 10, title: "feat: real work" }),
      makeIssue({
        number: 20,
        title: "fix: ci failure",
        labels: ["ci-failure"],
      }),
      makeIssue({ number: 99, title: "Plan", labels: ["plan"] }),
    ];
    const client = makeClient({
      listIssues: vi.fn(async (_o, _r, labels?: string[]) => {
        if (labels?.includes("plan")) return [];
        return openIssues;
      }) as unknown as GitHubClient["listIssues"],
      createIssue: vi.fn().mockResolvedValue({ number: 100 }),
    });

    const result = await runPlanCoverage(client, "org", "repo");

    expect(result.appended).toEqual([10]);
  });

  it("classifies dev-scout labelled issues with kind dev-scout", async () => {
    const openIssues = [
      makeIssue({ number: 10, title: "chore: scout", labels: ["dev-scout"] }),
    ];
    const client = makeClient({
      listIssues: vi.fn(async (_o, _r, labels?: string[]) => {
        if (labels?.includes("plan")) return [];
        return openIssues;
      }) as unknown as GitHubClient["listIssues"],
      createIssue: vi.fn().mockResolvedValue({ number: 100 }),
    });

    await runPlanCoverage(client, "org", "repo");
    const body = (client.createIssue as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].body;
    expect(body).toContain('"kind":"dev-scout"');
    expect(body).toContain("[dev-scout]");
  });

  it("is a no-op when all issues are already covered", async () => {
    const planBody = `## Phase: Backlog

Goal:
Depends on phases: None.
Scout gate: pending

- #10 — feat: one [risk: 3]
  <!-- superfield: {"number":10,"title":"feat: one","phase":"Backlog","kind":"feature","risk":3,"dependencies":[],"parallel_safe":true} -->
`;
    const client = makeClient({
      listIssues: vi.fn(async (_o, _r, labels?: string[]) => {
        if (labels?.includes("plan")) return [{ number: 99, body: planBody }];
        return [makeIssue({ number: 10 })];
      }) as unknown as GitHubClient["listIssues"],
      updateIssueBody: vi.fn(),
    });

    const result = await runPlanCoverage(client, "org", "repo");

    expect(result.appended).toEqual([]);
    expect(result.alreadyCovered).toEqual([10]);
    expect(client.updateIssueBody).not.toHaveBeenCalled();
  });

  it.todo(
    "preserves phase placement, ordering, and dependency metadata when appending uncovered issues",
  );
});
