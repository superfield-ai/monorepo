import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { GitHubClient } from '@superfield/github';
import { runWatchdog } from '../../watchdog.ts';
import getBranch from '../../../../tests/fixtures/github/get-branch.json';
import checkRunsFailed from '../../../../tests/fixtures/github/check-runs-failed.json';
import issueCreated from '../../../../tests/fixtures/github/issue-created.json';
import issuesEmpty from '../../../../tests/fixtures/github/issues-empty.json';
import issuesWithPlan from '../../../../tests/fixtures/github/issues-with-plan.json';

const BASE = 'https://api.github.com';
const SHA = getBranch.commit.sha;
const SHORT_SHA = SHA.slice(0, 7);

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function failedRun() {
  return checkRunsFailed.check_runs.find((r) => r.conclusion === 'failure')!;
}

describe('runWatchdog — issue created', () => {
  it('creates a ci-failure issue and a new Plan issue when none exist', async () => {
    const createdIssues: unknown[] = [];

    server.use(
      // No existing ci-failure issues
      http.get(`${BASE}/repos/test-org/test-repo/issues`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('labels')?.includes('ci-failure')) return HttpResponse.json(issuesEmpty);
        if (url.searchParams.get('labels')?.includes('plan')) return HttpResponse.json(issuesEmpty);
        return HttpResponse.json(issuesEmpty);
      }),
      http.post(`${BASE}/repos/test-org/test-repo/issues`, async ({ request }) => {
        const body = await request.json() as { title: string };
        createdIssues.push(body);
        return HttpResponse.json(issueCreated, { status: 201 });
      }),
    );

    const client = new GitHubClient('test-token');
    const run = failedRun();
    const result = await runWatchdog(client, 'test-org', 'test-repo', SHA, {
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      head_sha: run.head_sha,
    });

    expect(result.issueCreated).toBe(true);
    expect(result.issue?.number).toBe(42);
    // Two issues created: the ci-failure issue + the Plan issue
    expect(createdIssues).toHaveLength(2);
  });
});

describe('runWatchdog — deduplication', () => {
  it('skips creating an issue when one already exists for the same SHA + check', async () => {
    const existingTitle = `fix(test-repo): test:unit failed on main @ ${SHORT_SHA}`;

    server.use(
      http.get(`${BASE}/repos/test-org/test-repo/issues`, () =>
        HttpResponse.json([{ ...issueCreated, title: existingTitle }]),
      ),
    );

    const client = new GitHubClient('test-token');
    const run = failedRun();
    const result = await runWatchdog(client, 'test-org', 'test-repo', SHA, {
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      head_sha: run.head_sha,
    });

    expect(result.issueCreated).toBe(false);
    expect(result.skipped).toBe(true);
  });
});

describe('runWatchdog — Plan issue exists', () => {
  it('appends to an existing Plan issue instead of creating a new one', async () => {
    let updatedBody = '';

    server.use(
      http.get(`${BASE}/repos/test-org/test-repo/issues`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('labels')?.includes('ci-failure')) return HttpResponse.json(issuesEmpty);
        if (url.searchParams.get('labels')?.includes('plan')) return HttpResponse.json(issuesWithPlan);
        return HttpResponse.json(issuesEmpty);
      }),
      http.post(`${BASE}/repos/test-org/test-repo/issues`, async () =>
        HttpResponse.json(issueCreated, { status: 201 }),
      ),
      http.patch(`${BASE}/repos/test-org/test-repo/issues/1`, async ({ request }) => {
        const body = await request.json() as { body: string };
        updatedBody = body.body;
        return HttpResponse.json({ ...issuesWithPlan[0], body: updatedBody });
      }),
    );

    const client = new GitHubClient('test-token');
    const run = failedRun();
    await runWatchdog(client, 'test-org', 'test-repo', SHA, {
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      head_sha: run.head_sha,
    });

    expect(updatedBody).toContain('#42');
    expect(updatedBody).not.toContain('[ ]');
  });
});
