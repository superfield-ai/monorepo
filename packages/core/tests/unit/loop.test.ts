/**
 * Unit tests for packages/core/loop.ts — planning loop wiring.
 *
 * Uses injectable step functions (same pattern as tickDevLoop) to verify
 * that tickRepositoryForTesting calls all four planning-loop steps and
 * isolates failures in each step so the tick continues.
 *
 * Issue #2: wire runIssueAudit + runBlueprintConformance into tickRepository.
 */
import { describe, it, expect, vi } from 'vitest';
import { tickRepositoryForTesting } from '../../loop.ts';
import type { GitHubClient, Issue } from '@superfield/github';
import type { IssueAuditResult } from '../../steps/issue-audit.ts';
import type { BlueprintConformanceResult } from '../../steps/blueprint-conformance.ts';
import type { PlanCoverageResult } from '../../steps/plan-coverage.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: 'feat: example',
    body: '## Phase\nBacklog\n## Motivation\nBecause.\n## Features\n- thing\n## Test Plan\n- test it',
    html_url: 'https://github.com/org/repo/issues/1',
    state: 'open',
    labels: [],
    ...overrides,
  };
}

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getHeadSha: vi.fn().mockResolvedValue('abc123'),
    getCheckRuns: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([makeIssue()]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue({ number: 99, title: 'Plan', body: '', labels: ['plan'] }),
    updateIssueBody: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

const noOpAudit = vi.fn(
  async (): Promise<IssueAuditResult> => ({ audited: 0, nonConformant: [], reports: {} }),
);

const noOpBlueprint = vi.fn(
  async (): Promise<BlueprintConformanceResult> => ({
    checked: 0,
    issuesWithViolations: [],
    reports: {},
  }),
);

const noOpCoverage = vi.fn(
  async (): Promise<PlanCoverageResult> => ({ planCreated: false, appended: [], alreadyCovered: [] }),
);

// ── tests ─────────────────────────────────────────────────────────────────────

describe('tickRepository — all four planning-loop steps are wired', () => {
  it('calls runIssueAudit once per tick', async () => {
    const audit = vi.fn(noOpAudit);
    const client = makeClient();
    await tickRepositoryForTesting(client, 'org', 'repo', {
      issueAudit: audit,
      blueprintConformance: noOpBlueprint,
      planCoverage: noOpCoverage,
    });
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(client, 'org', 'repo', expect.any(Object));
  });

  it('calls runBlueprintConformance once per tick', async () => {
    const blueprint = vi.fn(noOpBlueprint);
    const client = makeClient();
    await tickRepositoryForTesting(client, 'org', 'repo', {
      issueAudit: noOpAudit,
      blueprintConformance: blueprint,
      planCoverage: noOpCoverage,
    });
    expect(blueprint).toHaveBeenCalledOnce();
    expect(blueprint).toHaveBeenCalledWith(client, 'org', 'repo', expect.any(Object));
  });

  it('calls runPlanCoverage once per tick', async () => {
    const coverage = vi.fn(noOpCoverage);
    const client = makeClient();
    await tickRepositoryForTesting(client, 'org', 'repo', {
      issueAudit: noOpAudit,
      blueprintConformance: noOpBlueprint,
      planCoverage: coverage,
    });
    expect(coverage).toHaveBeenCalledOnce();
    expect(coverage).toHaveBeenCalledWith(client, 'org', 'repo');
  });

  it('runIssueAudit failure does not abort the tick', async () => {
    const coverage = vi.fn(noOpCoverage);
    const client = makeClient();
    await expect(
      tickRepositoryForTesting(client, 'org', 'repo', {
        issueAudit: async () => { throw new Error('audit boom'); },
        blueprintConformance: noOpBlueprint,
        planCoverage: coverage,
      }),
    ).resolves.not.toThrow();
    // plan-coverage should still have run
    expect(coverage).toHaveBeenCalled();
  });

  it('runBlueprintConformance failure does not abort the tick', async () => {
    const coverage = vi.fn(noOpCoverage);
    const client = makeClient();
    await expect(
      tickRepositoryForTesting(client, 'org', 'repo', {
        issueAudit: noOpAudit,
        blueprintConformance: async () => { throw new Error('blueprint boom'); },
        planCoverage: coverage,
      }),
    ).resolves.not.toThrow();
    expect(coverage).toHaveBeenCalled();
  });

  it('returns structured result with step outcomes', async () => {
    const client = makeClient();
    const result = await tickRepositoryForTesting(client, 'org', 'repo', {
      issueAudit: noOpAudit,
      blueprintConformance: noOpBlueprint,
      planCoverage: noOpCoverage,
    });
    expect(result.issueAudit.ok).toBe(true);
    expect(result.planCoverage.ok).toBe(true);
    expect(result.blueprintConformance.ok).toBe(true);
  });

  it('captures step error in structured result when issueAudit fails', async () => {
    const client = makeClient();
    const result = await tickRepositoryForTesting(client, 'org', 'repo', {
      issueAudit: async () => { throw new Error('audit boom'); },
      blueprintConformance: noOpBlueprint,
      planCoverage: noOpCoverage,
    });
    expect(result.issueAudit.ok).toBe(false);
    if (!result.issueAudit.ok) {
      expect(result.issueAudit.error).toContain('audit boom');
    }
    // Other steps still succeeded
    expect(result.planCoverage.ok).toBe(true);
    expect(result.blueprintConformance.ok).toBe(true);
  });

  it('runPlanCoverage failure does not abort the tick', async () => {
    const blueprint = vi.fn(noOpBlueprint);
    const client = makeClient();
    await expect(
      tickRepositoryForTesting(client, 'org', 'repo', {
        issueAudit: noOpAudit,
        blueprintConformance: blueprint,
        planCoverage: async () => { throw new Error('coverage boom'); },
      }),
    ).resolves.not.toThrow();
    // blueprint-conformance should still have been called (comes after plan-coverage)
    expect(blueprint).toHaveBeenCalled();
  });
});
