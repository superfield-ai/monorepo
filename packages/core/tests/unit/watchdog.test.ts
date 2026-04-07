import { describe, it, expect } from 'vitest';
import {
  hasFailedChecks,
  buildCIFailureIssueTitle,
  buildCIFailureIssueBody,
  buildPlanEntryLine,
} from '../../watchdog.ts';
import type { CheckRun } from '@superfield/github';

function makeRun(overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 1,
    name: 'test:unit',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/org/repo/runs/1',
    head_sha: 'abc1234',
    ...overrides,
  };
}

describe('hasFailedChecks', () => {
  it('returns empty when all checks pass', () => {
    const runs = [makeRun(), makeRun({ id: 2, name: 'build' })];
    expect(hasFailedChecks(runs)).toHaveLength(0);
  });

  it('returns only failed completed checks', () => {
    const runs = [
      makeRun({ conclusion: 'failure' }),
      makeRun({ id: 2, name: 'build', conclusion: 'success' }),
      makeRun({ id: 3, name: 'lint', status: 'in_progress', conclusion: null }),
    ];
    const failed = hasFailedChecks(runs);
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe('test:unit');
  });

  it('ignores in-progress checks', () => {
    const runs = [makeRun({ status: 'in_progress', conclusion: null })];
    expect(hasFailedChecks(runs)).toHaveLength(0);
  });
});

describe('buildCIFailureIssueTitle', () => {
  it('formats title correctly', () => {
    const title = buildCIFailureIssueTitle('my-repo', 'test:unit', 'a1b2c3d');
    expect(title).toBe('fix(my-repo): test:unit failed on main @ a1b2c3d');
  });
});

describe('buildCIFailureIssueBody', () => {
  it('includes all required Calypso issue sections', () => {
    const body = buildCIFailureIssueBody('test:unit', 'abc1234', 'https://github.com/runs/1');
    expect(body).toContain('## Issue type\nci-failure');
    expect(body).toContain('## Phase\nwatchdog');
    expect(body).toContain('## Motivation');
    expect(body).toContain('## Canonical docs');
    expect(body).toContain('## Deliverables');
    expect(body).toContain('## Acceptance Criteria');
    expect(body).toContain('## Test Plan');
    expect(body).toContain('https://github.com/runs/1');
  });
});

describe('buildPlanEntryLine', () => {
  it('formats a plain reference with no checkboxes', () => {
    const line = buildPlanEntryLine(42, 'fix(repo): test failed @ abc1234');
    expect(line).toMatch(/^- #42 — fix\(repo\): test failed @ abc1234/);
    expect(line).not.toContain('[ ]');
  });
});
