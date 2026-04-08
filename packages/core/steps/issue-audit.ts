import type { GitHubClient, Issue } from '@superfield/github';
import { buildIssueAuditPrompt } from '../prompts/index.ts';
import { runLLMTask, type LLMTaskOpts } from '../llm-task.ts';

export interface IssueAuditReport {
  issue_number: number;
  conformant: boolean;
  missing_sections: string[];
  forbidden_sections: string[];
  empty_sections: string[];
  fix_suggestions: string[];
}

export interface IssueAuditResult {
  audited: number;
  nonConformant: number[];
  /** Detailed reports keyed by issue number. */
  reports: Record<number, IssueAuditReport>;
}

export interface IssueAuditOpts {
  /** Override the spawn function for testing. */
  spawn?: LLMTaskOpts['spawn'];
  /** cwd passed to the LLM subprocess. */
  cwd?: string;
  /** Max concurrent audit calls (default: 3). */
  concurrency?: number;
}

/**
 * Planning loop step: audit every open issue against the IssueBody schema.
 * For each non-conformant issue, post a comment describing what is missing
 * and apply the `non-conformant` label.
 *
 * LLM-driven via `buildIssueAuditPrompt`. Concurrency is capped so we don't
 * fan out thousands of subprocess spawns on large repos.
 */
export async function runIssueAudit(
  client: GitHubClient,
  owner: string,
  repo: string,
  opts: IssueAuditOpts = {},
): Promise<IssueAuditResult> {
  const allIssues = await client.listIssues(owner, repo);

  // Skip the Plan issue itself and ci-failure issues (those have a
  // watchdog-owned body we don't want to audit against the feature schema)
  const candidates = allIssues.filter(
    (i) =>
      !i.labels.includes('plan') &&
      !i.labels.includes('ci-failure') &&
      !i.labels.includes('non-conformant'),
  );

  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const reports: Record<number, IssueAuditReport> = {};
  const nonConformant: number[] = [];

  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((issue) => auditOne(client, owner, repo, issue, opts)),
    );
    for (const r of results) {
      reports[r.issue_number] = r;
      if (!r.conformant) nonConformant.push(r.issue_number);
    }
  }

  return { audited: candidates.length, nonConformant, reports };
}

async function auditOne(
  client: GitHubClient,
  owner: string,
  repo: string,
  issue: Issue,
  opts: IssueAuditOpts,
): Promise<IssueAuditReport> {
  const prompt = buildIssueAuditPrompt({ issue });

  const { result } = await runLLMTask<IssueAuditReport>(
    { prompt, spawn: opts.spawn, cwd: opts.cwd },
    (json) => {
      const parsed = JSON.parse(json) as Partial<IssueAuditReport>;
      if (typeof parsed.issue_number !== 'number') {
        throw new Error('missing issue_number');
      }
      if (typeof parsed.conformant !== 'boolean') {
        throw new Error('missing conformant');
      }
      return {
        issue_number: parsed.issue_number,
        conformant: parsed.conformant,
        missing_sections: parsed.missing_sections ?? [],
        forbidden_sections: parsed.forbidden_sections ?? [],
        empty_sections: parsed.empty_sections ?? [],
        fix_suggestions: parsed.fix_suggestions ?? [],
      };
    },
  );

  if (!result.conformant) {
    await postAuditFindings(client, owner, repo, issue.number, result);
  }

  return result;
}

async function postAuditFindings(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  report: IssueAuditReport,
): Promise<void> {
  const lines: string[] = [
    '## Schema audit — non-conformant',
    '',
    'This issue does not conform to the Superfield `IssueBody` schema. \
See `docs/prd.md` §Issue Schema.',
    '',
  ];

  if (report.missing_sections.length > 0) {
    lines.push('**Missing required sections:**');
    lines.push(...report.missing_sections.map((s) => `- ${s}`));
    lines.push('');
  }
  if (report.forbidden_sections.length > 0) {
    lines.push('**Forbidden sections present:**');
    lines.push(...report.forbidden_sections.map((s) => `- ${s}`));
    lines.push('');
  }
  if (report.empty_sections.length > 0) {
    lines.push('**Empty sections:**');
    lines.push(...report.empty_sections.map((s) => `- ${s}`));
    lines.push('');
  }
  if (report.fix_suggestions.length > 0) {
    lines.push('**Suggested fixes:**');
    lines.push(...report.fix_suggestions.map((s) => `- ${s}`));
    lines.push('');
  }

  const marker = '<!-- superfield-audit -->';
  const body = `${marker}\n${lines.join('\n')}`;

  // Dedupe: find existing audit comment by marker, update rather than duplicate
  const comments = await client.listIssueComments(owner, repo, issueNumber);
  const existing = comments.find((c) => c.body.startsWith(marker));
  if (existing) {
    await client.updateIssueComment(owner, repo, existing.id, body);
  } else {
    await client.createIssueComment(owner, repo, issueNumber, body);
  }
}
