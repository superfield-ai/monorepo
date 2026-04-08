import type { GitHubClientPort as GitHubClient, Issue } from '@superfield/github';
import { buildBlueprintConformancePrompt } from '../prompts/index.ts';
import { runLLMTask, type LLMTaskOpts } from '../llm-task.ts';
import { loadBlueprint, pickCandidateDomains, type Blueprint } from '../blueprint.ts';

export interface BlueprintViolation {
  rule_id: string;
  rule_name: string;
  rule_type: string;
  domain: string;
  concern: string;
}

export interface BlueprintConformanceReport {
  issue_number: number;
  violations: BlueprintViolation[];
}

export interface BlueprintConformanceResult {
  checked: number;
  issuesWithViolations: number[];
  reports: Record<number, BlueprintConformanceReport>;
}

export interface BlueprintConformanceOpts {
  spawn?: LLMTaskOpts['spawn'];
  cwd?: string;
  concurrency?: number;
  /** Pre-loaded blueprint. If omitted, loaded from `cwd`/blueprint. */
  blueprint?: Blueprint;
}

const MARKER = '<!-- superfield-blueprint -->';

/**
 * Planning loop step: evaluate each open issue against candidate blueprint
 * domains and post advisory violation comments. Non-blocking — only informs.
 *
 * Dedupe: comments carry the `<!-- superfield-blueprint -->` marker so
 * subsequent runs update the existing comment rather than create duplicates.
 */
export async function runBlueprintConformance(
  client: GitHubClient,
  owner: string,
  repo: string,
  opts: BlueprintConformanceOpts = {},
): Promise<BlueprintConformanceResult> {
  const blueprint = opts.blueprint ?? (await loadBlueprint());

  const allIssues = await client.listIssues(owner, repo);
  const candidates = allIssues.filter(
    (i) => !i.labels.includes('plan') && !i.labels.includes('ci-failure'),
  );

  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const reports: Record<number, BlueprintConformanceReport> = {};
  const issuesWithViolations: number[] = [];

  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((issue) => checkOne(client, owner, repo, issue, blueprint, opts)),
    );
    for (const r of results) {
      if (!r) continue;
      reports[r.issue_number] = r;
      if (r.violations.length > 0) {
        issuesWithViolations.push(r.issue_number);
      }
    }
  }

  return { checked: candidates.length, issuesWithViolations, reports };
}

async function checkOne(
  client: GitHubClient,
  owner: string,
  repo: string,
  issue: Issue,
  _blueprint: Blueprint,
  opts: BlueprintConformanceOpts,
): Promise<BlueprintConformanceReport | null> {
  const candidateDomains = pickCandidateDomains({
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
  });

  // No relevant domain — skip, no violations to report
  if (candidateDomains.length === 0) {
    return { issue_number: issue.number, violations: [] };
  }

  const prompt = buildBlueprintConformancePrompt({ issue, candidateDomains });

  const { result } = await runLLMTask<BlueprintConformanceReport>(
    { prompt, spawn: opts.spawn, cwd: opts.cwd },
    (json) => {
      const parsed = JSON.parse(json) as Partial<BlueprintConformanceReport>;
      if (typeof parsed.issue_number !== 'number') {
        throw new Error('missing issue_number');
      }
      if (!Array.isArray(parsed.violations)) {
        throw new Error('missing violations array');
      }
      return {
        issue_number: parsed.issue_number,
        violations: parsed.violations,
      };
    },
  );

  if (result.violations.length > 0) {
    await postConformanceFindings(client, owner, repo, issue.number, result);
  } else {
    // No violations — delete any stale advisory comment
    await deleteStaleAdvisory(client, owner, repo, issue.number);
  }

  return result;
}

async function postConformanceFindings(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  report: BlueprintConformanceReport,
): Promise<void> {
  const lines: string[] = [
    MARKER,
    '## Blueprint conformance — advisory',
    '',
    'This issue may conflict with rules in the Superfield Blueprint. These \
findings are advisory — they do not block the issue from being worked. The \
agent picking up this issue should weigh each concern.',
    '',
  ];

  for (const v of report.violations) {
    lines.push(`### \`${v.rule_id}\` — ${v.rule_name} (${v.rule_type}, ${v.domain})`);
    lines.push('');
    lines.push(v.concern);
    lines.push('');
  }

  const body = lines.join('\n');
  const comments = await client.listIssueComments(owner, repo, issueNumber);
  const existing = comments.find((c) => c.body.startsWith(MARKER));
  if (existing) {
    if (existing.body.trim() === body.trim()) return; // no change, skip
    await client.updateIssueComment(owner, repo, existing.id, body);
  } else {
    await client.createIssueComment(owner, repo, issueNumber, body);
  }
}

async function deleteStaleAdvisory(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  const comments = await client.listIssueComments(owner, repo, issueNumber);
  const stale = comments.find((c) => c.body.startsWith(MARKER));
  if (stale) {
    await client.deleteIssueComment(owner, repo, stale.id);
  }
}
