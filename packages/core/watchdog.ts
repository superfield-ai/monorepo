import type { GitHubClient, CheckRun, Issue } from '@superfield/github';

export interface WatchdogResult {
  issueCreated: boolean;
  issue?: Issue;
  skipped: boolean;
  reason?: string;
}

export function hasFailedChecks(runs: CheckRun[]): CheckRun[] {
  return runs.filter((r) => r.status === 'completed' && r.conclusion === 'failure');
}

export function buildCIFailureIssueTitle(repoName: string, checkName: string, shortSha: string): string {
  return `fix(${repoName}): ${checkName} failed on main @ ${shortSha}`;
}

export function buildCIFailureIssueBody(checkName: string, sha: string, checkRunUrl: string): string {
  return [
    '## Phase',
    'watchdog',
    '',
    '## Motivation',
    `${checkName} failed on commit ${sha}, blocking main`,
    '',
    '## Canonical docs',
    `- ${checkRunUrl}`,
    '',
    '## Features',
    `- [ ] Investigate root cause of ${checkName} failure`,
    `- [ ] Apply minimal targeted fix`,
    `- [ ] Verify ${checkName} passes locally`,
    '',
    '## Test Plan',
    `- [ ] ${checkName} passes on main`,
    '- [ ] No related regressions introduced',
  ].join('\n');
}

export function buildPlanEntryLine(issueNumber: number, title: string): string {
  return `- #${issueNumber} — ${title} (${new Date().toISOString()})`;
}

export async function runWatchdog(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
  failedRun: CheckRun,
): Promise<WatchdogResult> {
  const shortSha = sha.slice(0, 7);
  const title = buildCIFailureIssueTitle(repo, failedRun.name, shortSha);

  // Deduplicate: check for an existing open issue with the same title
  const existing = await client.listIssues(owner, repo, ['ci-failure']);
  const duplicate = existing.find((i) => i.title === title);
  if (duplicate) {
    return { issueCreated: false, skipped: true, reason: `duplicate of #${duplicate.number}` };
  }

  const body = buildCIFailureIssueBody(failedRun.name, sha, failedRun.html_url);
  const issue = await client.createIssue({ owner, repo, title, body, labels: ['ci-failure', 'watchdog'] });

  await upsertPlanIssue(client, owner, repo, issue.number, title);

  return { issueCreated: true, issue, skipped: false };
}

async function upsertPlanIssue(
  client: GitHubClient,
  owner: string,
  repo: string,
  newIssueNumber: number,
  newIssueTitle: string,
): Promise<void> {
  const plans = await client.listIssues(owner, repo, ['plan']);
  const entry = buildPlanEntryLine(newIssueNumber, newIssueTitle);

  if (plans.length === 0) {
    await client.createIssue({
      owner,
      repo,
      title: 'Plan',
      body: entry + '\n',
      labels: ['plan'],
    });
    return;
  }

  const plan = plans[0];
  const currentBody = plan.body ?? '';
  await client.updateIssueBody({
    owner,
    repo,
    issue_number: plan.number,
    body: currentBody + entry + '\n',
  });
}
