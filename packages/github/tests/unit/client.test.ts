import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { GitHubClient } from '../../client.ts';
import checkRunsPassing from '../../../../tests/fixtures/github/check-runs-passing.json';
import checkRunsFailed from '../../../../tests/fixtures/github/check-runs-failed.json';
import getBranch from '../../../../tests/fixtures/github/get-branch.json';
import issueCreated from '../../../../tests/fixtures/github/issue-created.json';
import issuesEmpty from '../../../../tests/fixtures/github/issues-empty.json';

const BASE = 'https://api.github.com';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('GitHubClient.getHeadSha', () => {
  it('returns the SHA of the branch HEAD', async () => {
    server.use(
      http.get(`${BASE}/repos/test-org/test-repo/branches/main`, () =>
        HttpResponse.json(getBranch),
      ),
    );

    const client = new GitHubClient('test-token');
    const sha = await client.getHeadSha('test-org', 'test-repo');
    expect(sha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  });
});

describe('GitHubClient.getCheckRuns', () => {
  it('returns passing check runs', async () => {
    server.use(
      http.get(`${BASE}/repos/test-org/test-repo/commits/:ref/check-runs`, () =>
        HttpResponse.json(checkRunsPassing),
      ),
    );

    const client = new GitHubClient('test-token');
    const runs = await client.getCheckRuns('test-org', 'test-repo', 'abc123');
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.conclusion === 'success')).toBe(true);
  });

  it('returns failed check runs', async () => {
    server.use(
      http.get(`${BASE}/repos/test-org/test-repo/commits/:ref/check-runs`, () =>
        HttpResponse.json(checkRunsFailed),
      ),
    );

    const client = new GitHubClient('test-token');
    const runs = await client.getCheckRuns('test-org', 'test-repo', 'abc123');
    const failed = runs.filter((r) => r.conclusion === 'failure');
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe('test:unit');
  });
});

describe('GitHubClient.listIssues', () => {
  it('returns empty list when no issues', async () => {
    server.use(
      http.get(`${BASE}/repos/test-org/test-repo/issues`, () =>
        HttpResponse.json(issuesEmpty),
      ),
    );

    const client = new GitHubClient('test-token');
    const issues = await client.listIssues('test-org', 'test-repo');
    expect(issues).toHaveLength(0);
  });
});

describe('GitHubClient.createIssue', () => {
  it('sends correct payload and returns created issue', async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${BASE}/repos/test-org/test-repo/issues`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(issueCreated, { status: 201 });
      }),
    );

    const client = new GitHubClient('test-token');
    const issue = await client.createIssue({
      owner: 'test-org',
      repo: 'test-repo',
      title: issueCreated.title,
      body: issueCreated.body,
      labels: ['ci-failure', 'watchdog'],
    });

    expect(issue.number).toBe(42);
    expect((capturedBody as { labels: string[] }).labels).toEqual(['ci-failure', 'watchdog']);
  });
});
