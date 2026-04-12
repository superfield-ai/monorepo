/**
 * Integration tests for the planning loop — all four steps composing one tick.
 *
 * Layer 2 tests (docs/testing.md): use the injectable step API from
 * tickRepositoryForTesting with a mock GitHubClient and fake step functions.
 * No real claude subprocess; no real GitHub API.
 *
 * Goal: verify the orchestration — that each step's output feeds into the
 * right forge calls and the composite TickRepositoryResult is correct.
 *
 * Issue #3: planning loop integration test composing all four steps.
 */
import { describe, it, expect, vi } from "vitest";
import { tickRepositoryForTesting } from "../../loop.ts";
import type { GitHubClient, Issue, CheckRun } from "@superfield/github";
import type { IssueAuditResult } from "../../steps/issue-audit.ts";
import type { BlueprintConformanceResult } from "../../steps/blueprint-conformance.ts";
import type { PlanCoverageResult } from "../../steps/plan-coverage.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "feat: example",
    body: null,
    html_url: "https://github.com/org/repo/issues/1",
    state: "open",
    labels: [],
    ...overrides,
  };
}

const conformantPlanBody = `## Phase: Backlog

Goal: initial.
Depends on phases: None.
Scout gate: none

- #1 — feat: example [risk: 3]
  <!-- superfield: {"number":1,"title":"feat: example","phase":"Backlog","kind":"feature","risk":3,"dependencies":[],"parallel_safe":true} -->
`;

function makeCheckRun(overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 1,
    name: "test:unit",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/org/repo/runs/1",
    head_sha: "abc123",
    ...overrides,
  };
}

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getHeadSha: vi.fn().mockResolvedValue("abc123"),
    getCheckRuns: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([
      makeIssue({
        number: 99,
        labels: ["plan"],
        body: conformantPlanBody,
        title: "Plan",
      }),
      makeIssue({ number: 1 }),
    ]),
    getIssue: vi.fn().mockResolvedValue(makeIssue()),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue({
      number: 100,
      title: "CI failure",
      labels: [],
      body: "",
      html_url: "",
    }),
    updateIssueBody: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

// Fake step implementations
function fakeAudit(result: Partial<IssueAuditResult> = {}) {
  return vi.fn(
    async (): Promise<IssueAuditResult> => ({
      audited: 0,
      nonConformant: [],
      reports: {},
      ...result,
    }),
  );
}

function fakeBlueprint(result: Partial<BlueprintConformanceResult> = {}) {
  return vi.fn(
    async (): Promise<BlueprintConformanceResult> => ({
      checked: 0,
      issuesWithViolations: [],
      reports: {},
      ...result,
    }),
  );
}

function fakeCoverage(result: Partial<PlanCoverageResult> = {}) {
  return vi.fn(
    async (): Promise<PlanCoverageResult> => ({
      planCreated: false,
      appended: [],
      alreadyCovered: [],
      skipped: [],
      llmPlaced: [],
      createdPhases: [],
      ...result,
    }),
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("planning loop — end to end", () => {
  it("CI watchdog detects failed check and inserts ci-failure at top of Plan", async () => {
    const client = makeClient({
      getCheckRuns: vi.fn().mockResolvedValue([makeCheckRun()]),
      listIssues: vi.fn().mockResolvedValue([
        makeIssue({
          number: 99,
          title: "Plan",
          labels: ["plan"],
          body: conformantPlanBody,
        }),
        makeIssue(),
      ]),
      // planContainsIssue check and plan update
      updateIssueBody: vi.fn().mockResolvedValue(undefined),
    });

    const result = await tickRepositoryForTesting(client, "org", "repo", {
      issueAudit: fakeAudit(),
      blueprintConformance: fakeBlueprint(),
      planCoverage: fakeCoverage(),
    });

    // Watchdog should have found the failure and created a ci-failure issue
    expect(client.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.arrayContaining(["ci-failure"]),
      }),
    );
    expect(result.watchdogIssuesCreated.length).toBeGreaterThan(0);
  });

  it("plan-coverage appends new open issue to the Plan", async () => {
    const client = makeClient();
    const coverage = fakeCoverage({ appended: [1], planCreated: false });

    const result = await tickRepositoryForTesting(client, "org", "repo", {
      issueAudit: fakeAudit(),
      blueprintConformance: fakeBlueprint(),
      planCoverage: coverage,
    });

    expect(result.planCoverage.ok).toBe(true);
    if (result.planCoverage.ok) {
      expect(result.planCoverage.appended).toContain(1);
    }
    expect(coverage).toHaveBeenCalledOnce();
  });

  it("issue-audit reports non-conformant issues in structured result", async () => {
    const client = makeClient();
    const audit = fakeAudit({ audited: 2, nonConformant: [7, 8] });

    const result = await tickRepositoryForTesting(client, "org", "repo", {
      issueAudit: audit,
      blueprintConformance: fakeBlueprint(),
      planCoverage: fakeCoverage(),
    });

    expect(result.issueAudit.ok).toBe(true);
    if (result.issueAudit.ok) {
      expect(result.issueAudit.nonConformant).toEqual([7, 8]);
    }
  });

  it("blueprint-conformance reports violations in structured result", async () => {
    const client = makeClient();
    const blueprint = fakeBlueprint({ checked: 1, issuesWithViolations: [5] });

    const result = await tickRepositoryForTesting(client, "org", "repo", {
      issueAudit: fakeAudit(),
      blueprintConformance: blueprint,
      planCoverage: fakeCoverage(),
    });

    expect(result.blueprintConformance.ok).toBe(true);
    if (result.blueprintConformance.ok) {
      expect(result.blueprintConformance.issuesWithViolations).toEqual([5]);
    }
  });

  it("multiple steps composing one tick produce the expected forge state", async () => {
    const client = makeClient();
    const coverage = fakeCoverage({ appended: [42], planCreated: true });
    const audit = fakeAudit({ nonConformant: [3] });
    const blueprint = fakeBlueprint({ issuesWithViolations: [3] });

    const result = await tickRepositoryForTesting(client, "org", "repo", {
      issueAudit: audit,
      blueprintConformance: blueprint,
      planCoverage: coverage,
    });

    // All four steps ran
    expect(coverage).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
    expect(blueprint).toHaveBeenCalledOnce();

    // All step outcomes are captured
    expect(result.planCoverage.ok).toBe(true);
    expect(result.issueAudit.ok).toBe(true);
    expect(result.blueprintConformance.ok).toBe(true);

    if (result.planCoverage.ok) {
      expect(result.planCoverage.planCreated).toBe(true);
      expect(result.planCoverage.appended).toEqual([42]);
    }
    if (result.issueAudit.ok) {
      expect(result.issueAudit.nonConformant).toEqual([3]);
    }
    if (result.blueprintConformance.ok) {
      expect(result.blueprintConformance.issuesWithViolations).toEqual([3]);
    }
  });

  it("reuses one open-issues snapshot across planning steps", async () => {
    const client = makeClient({
      getCheckRuns: vi.fn().mockResolvedValue([]),
      listIssues: vi.fn().mockResolvedValue([
        makeIssue({
          number: 99,
          title: "Plan",
          labels: ["plan"],
          body: conformantPlanBody,
        }),
        makeIssue({ number: 7 }),
      ]),
    });

    await tickRepositoryForTesting(client, "org", "repo", {
      issueAudit: fakeAudit(),
      blueprintConformance: fakeBlueprint(),
      planCoverage: fakeCoverage(),
    });

    expect(client.listIssues).toHaveBeenCalledTimes(1);
  });

  it("watchdog error does not crash the planning loop — remaining steps still run", async () => {
    // Regression: a watchdog failure must be isolated so that issue-audit,
    // plan-coverage, and blueprint-conformance still execute in the same tick.
    const client = makeClient({
      // Cause the watchdog to throw by making getHeadSha reject
      getHeadSha: vi.fn().mockRejectedValue(new Error("network failure")),
    });

    const audit = fakeAudit({ nonConformant: [7] });
    const coverage = fakeCoverage({ appended: [2] });
    const blueprint = fakeBlueprint({ issuesWithViolations: [7] });

    const result = await tickRepositoryForTesting(client, "org", "repo", {
      issueAudit: audit,
      blueprintConformance: blueprint,
      planCoverage: coverage,
    });

    // Watchdog failed but must not crash the tick
    expect(result.watchdog.ok).toBe(false);
    if (!result.watchdog.ok) {
      expect(result.watchdog.error).toContain("network failure");
    }

    // All remaining steps must have executed successfully
    expect(audit).toHaveBeenCalledOnce();
    expect(coverage).toHaveBeenCalledOnce();
    expect(blueprint).toHaveBeenCalledOnce();

    expect(result.issueAudit.ok).toBe(true);
    expect(result.planCoverage.ok).toBe(true);
    expect(result.blueprintConformance.ok).toBe(true);

    if (result.issueAudit.ok) {
      expect(result.issueAudit.nonConformant).toEqual([7]);
    }
    if (result.planCoverage.ok) {
      expect(result.planCoverage.appended).toEqual([2]);
    }
    if (result.blueprintConformance.ok) {
      expect(result.blueprintConformance.issuesWithViolations).toEqual([7]);
    }
  });
});
