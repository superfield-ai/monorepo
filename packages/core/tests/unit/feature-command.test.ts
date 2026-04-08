import { describe, it, expect, vi } from "vitest";
import { runFeatureCommand } from "../../commands/feature.ts";
import type { GitHubClient, Issue } from "@superfield/github";
import type { AgentOpts, AgentResult } from "../../agent.ts";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 10,
    title: "feat: existing",
    body: "## Phase\nP\n\n## Motivation\nx\n\n## Features\n- [ ] x\n\n## Test Plan\n- [ ] x",
    html_url: "",
    state: "open",
    labels: ["feature"],
    ...overrides,
  };
}

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue({ number: 100, title: "new" }),
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

const validEvaluation = {
  title: "feat: add logout button",
  phase: "Identity",
  motivation: "Users need to log out cleanly.",
  features: ["Add button to navbar", "Wire up signOut handler"],
  test_plan: ["Click button → session cleared", "Redirect to login"],
  canonical_docs: ["docs/prd.md"],
  duplicate_of: null,
  blueprint_rules_cited: ["AUTH-P-001"],
};

describe("runFeatureCommand", () => {
  it("creates issue and Plan when both are absent", async () => {
    const client = makeClient();
    const result = await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "add a logout button",
      spawn: fakeSpawn(validEvaluation),
    });

    expect(result.duplicateOf).toBeNull();
    expect(result.issueCreated).toBe(100);
    expect(result.planCreated).toBe(true);
    expect(result.blueprintRulesCited).toEqual(["AUTH-P-001"]);

    // createIssue called twice: feature issue + plan issue
    expect(client.createIssue).toHaveBeenCalledTimes(2);
    const featureCall = (
      client.createIssue as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0].labels?.includes("feature"));
    expect(featureCall).toBeDefined();
    expect(featureCall![0].title).toBe("feat: add logout button");
    expect(featureCall![0].body).toContain("## Features");
    expect(featureCall![0].body).toContain("Add button to navbar");
  });

  it("appends to existing Plan when one exists", async () => {
    const planBody = `## Phase: Identity

Goal: existing
Depends on phases: None.
Scout gate: #5

- #5 — [dev-scout] s [risk: 5]
  <!-- superfield: {"number":5,"title":"s","phase":"Identity","kind":"dev-scout","risk":5,"dependencies":[],"parallel_safe":true} -->
`;
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([
        {
          number: 99,
          body: planBody,
          labels: ["plan"],
          state: "open",
          html_url: "",
          title: "Plan",
        },
        makeIssue({ number: 5, labels: ["dev-scout"] }),
      ]),
    });
    const result = await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "x",
      spawn: fakeSpawn(validEvaluation),
    });

    expect(result.planUpdated).toBe(true);
    expect(result.planCreated).toBe(false);
    expect(client.updateIssueBody).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 99 }),
    );
    const updateBody = (client.updateIssueBody as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].body;
    expect(updateBody).toContain("#100");
    expect(updateBody).toContain("feat: add logout button");
  });

  it("returns duplicate without creating issue or updating Plan", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue({ number: 50 })]),
    });
    const result = await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "x",
      spawn: fakeSpawn({ ...validEvaluation, duplicate_of: 50 }),
    });

    expect(result.duplicateOf).toBe(50);
    expect(result.issueCreated).toBeNull();
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.updateIssueBody).not.toHaveBeenCalled();
  });

  it("throws when duplicate_of is not a number or null", async () => {
    const client = makeClient();
    await expect(
      runFeatureCommand({
        client,
        owner: "o",
        repo: "r",
        request: "x",
        spawn: fakeSpawn({ ...validEvaluation, duplicate_of: "50" }),
      }),
    ).rejects.toThrow(/duplicate_of/);
  });

  it("throws when LLM response is missing required fields", async () => {
    const client = makeClient();
    await expect(
      runFeatureCommand({
        client,
        owner: "o",
        repo: "r",
        request: "x",
        spawn: fakeSpawn({ title: "no other fields" }),
      }),
    ).rejects.toThrow(/missing/);
  });

  it("uses LLM-supplied dependencies in the Plan entry", async () => {
    const client = makeClient();
    await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "add a logout button",
      spawn: fakeSpawn({ ...validEvaluation, dependencies: [5, 10] }),
    });

    const planBody = (
      client.createIssue as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0].labels?.includes("plan"))?.[0].body as string;
    expect(planBody).toContain('"dependencies":[5,10]');
  });

  it("defaults dependencies to [] when LLM omits the field", async () => {
    const client = makeClient();
    await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "add a logout button",
      spawn: fakeSpawn(validEvaluation), // validEvaluation has no dependencies field
    });

    const planBody = (
      client.createIssue as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0].labels?.includes("plan"))?.[0].body as string;
    expect(planBody).toContain('"dependencies":[]');
  });

  it("uses LLM-supplied risk score in the Plan entry", async () => {
    const client = makeClient();
    await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "add a logout button",
      spawn: fakeSpawn({ ...validEvaluation, risk: 7 }),
    });

    // The Plan issue body should contain risk: 7
    const planBody = (
      client.createIssue as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0].labels?.includes("plan"))?.[0].body as string;
    expect(planBody).toContain('"risk":7');
  });

  it("defaults risk to 3 when LLM omits the field", async () => {
    const evaluationNoRisk = { ...validEvaluation };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (evaluationNoRisk as any).risk;

    const client = makeClient();
    await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "add a logout button",
      spawn: fakeSpawn(evaluationNoRisk),
    });

    const planBody = (
      client.createIssue as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0].labels?.includes("plan"))?.[0].body as string;
    expect(planBody).toContain('"risk":3');
  });

  it("passes open issue titles to the prompt for duplicate detection", async () => {
    let receivedPrompt = "";
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ number: 7, title: "feat: thing one" }),
          makeIssue({ number: 8, title: "feat: thing two" }),
        ]),
    });
    await runFeatureCommand({
      client,
      owner: "o",
      repo: "r",
      request: "x",
      spawn: async (opts: AgentOpts) => {
        receivedPrompt = opts.prompt;
        return {
          sessionId: "s",
          output: JSON.stringify(validEvaluation),
          isError: false,
        };
      },
    });
    expect(receivedPrompt).toContain("feat: thing one");
    expect(receivedPrompt).toContain("feat: thing two");
  });
});
