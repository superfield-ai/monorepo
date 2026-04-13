import type {
  GitHubClientPort as GitHubClient,
  Issue,
} from "@superfield/github";
import { buildIssueAuditPrompt } from "../prompts/index.ts";
import { runLLMTask, type LLMTaskOpts } from "../llm-task.ts";

export interface IssueAuditReport {
  issue_number: number;
  conformant: boolean;
  missing_sections: string[];
  forbidden_sections: string[];
  empty_sections: string[];
  quality_issues: string[];
  proposed_body?: string;
}

export interface IssueAuditBatchResponse {
  reports: IssueAuditReport[];
}

export interface IssueAuditResult {
  audited: number;
  nonConformant: number[];
  /** Detailed reports keyed by issue number. */
  reports: Record<number, IssueAuditReport>;
}

export interface IssueAuditOpts {
  /** Override the spawn function for testing. */
  spawn?: LLMTaskOpts["spawn"];
  /** cwd passed to the LLM subprocess. */
  cwd?: string;
  /** Max concurrent audit calls (default: 3). */
  concurrency?: number;
  /** Optional pre-fetched open issues snapshot for this tick. */
  issues?: Issue[];
}

export const NON_CONFORMANT_LABEL = "non-conformant";
const ISSUE_AUDIT_BATCH_SIZE = 25;

/**
 * Planning loop step: audit open issues against the IssueBody schema and
 * repair malformed bodies in-place.
 *
 * The LLM runs on batches of issues so it can normalize multiple malformed
 * issues in one call. Non-conformant issues are rewritten via
 * `updateIssueBody()` and labelled `non-conformant`. Conformant issues have
 * stale audit comments and labels removed.
 */
export async function runIssueAudit(
  client: GitHubClient,
  owner: string,
  repo: string,
  opts: IssueAuditOpts = {},
): Promise<IssueAuditResult> {
  const allIssues = opts.issues ?? (await client.listIssues(owner, repo));
  const candidates = listAuditableIssues(allIssues);
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const issueBatches = chunkIssues(candidates, ISSUE_AUDIT_BATCH_SIZE);

  const reports: Record<number, IssueAuditReport> = {};
  const nonConformant: number[] = [];

  for (let i = 0; i < issueBatches.length; i += concurrency) {
    const batchGroup = issueBatches.slice(i, i + concurrency);
    const results = await Promise.all(
      batchGroup.map((batch) => auditBatch(client, owner, repo, batch, opts)),
    );

    for (const batchReports of results) {
      for (const report of batchReports) {
        reports[report.issue_number] = report;
        if (!report.conformant) nonConformant.push(report.issue_number);
      }
    }
  }

  return {
    audited: candidates.length,
    nonConformant,
    reports,
  };
}

/** Scout seam for #53 label normalization and relabel flow. */
export function listAuditableIssues(issues: Issue[]): Issue[] {
  return issues.filter(
    (i) => !i.labels.includes("plan") && !i.labels.includes("ci-failure"),
  );
}

async function auditBatch(
  client: GitHubClient,
  owner: string,
  repo: string,
  issues: Issue[],
  opts: IssueAuditOpts,
): Promise<IssueAuditReport[]> {
  const prompt = buildIssueAuditPrompt({ issues });

  const { result } = await runLLMTask<IssueAuditBatchResponse>(
    {
      prompt,
      spawn: opts.spawn,
      cwd: opts.cwd,
      model: "haiku",
      loop: "plan",
      task: "issue-audit",
      jobType: "issue-audit",
    },
    (json) => parseIssueAuditBatchResponse(json, issues),
  );

  const issueMap = new Map(issues.map((issue) => [issue.number, issue]));

  for (const report of result.reports) {
    const issue = issueMap.get(report.issue_number);
    if (!issue) {
      throw new Error(
        `issue audit returned unknown issue #${report.issue_number}`,
      );
    }

    await clearAuditFindings(client, owner, repo, issue.number);

    if (!report.conformant) {
      if (!report.proposed_body) {
        throw new Error(
          `issue audit returned non-conformant issue #${issue.number} without proposed_body`,
        );
      }

      if (issue.body !== report.proposed_body) {
        await client.updateIssueBody({
          owner,
          repo,
          issue_number: issue.number,
          body: report.proposed_body,
        });
      }

      if (!issue.labels.includes(NON_CONFORMANT_LABEL)) {
        await client.addIssueLabel({
          owner,
          repo,
          issue_number: issue.number,
          label: NON_CONFORMANT_LABEL,
        });
      }
    } else if (issue.labels.includes(NON_CONFORMANT_LABEL)) {
      await client.removeIssueLabel({
        owner,
        repo,
        issue_number: issue.number,
        label: NON_CONFORMANT_LABEL,
      });
    }
  }

  return result.reports;
}

function parseIssueAuditBatchResponse(
  json: string,
  issues: Issue[],
): IssueAuditBatchResponse {
  const parsed = JSON.parse(json) as Partial<IssueAuditBatchResponse>;
  if (!Array.isArray(parsed.reports)) {
    throw new Error("missing reports");
  }

  const reports = parsed.reports.map((report) => normalizeAuditReport(report));
  const expectedNumbers = new Set(issues.map((issue) => issue.number));
  const returnedNumbers = new Set<number>();

  for (const report of reports) {
    if (!expectedNumbers.has(report.issue_number)) {
      throw new Error(`unexpected issue_number ${report.issue_number}`);
    }
    if (returnedNumbers.has(report.issue_number)) {
      throw new Error(`duplicate issue_number ${report.issue_number}`);
    }
    returnedNumbers.add(report.issue_number);
  }

  if (reports.length !== issues.length) {
    throw new Error(
      `reports length mismatch: expected ${issues.length}, got ${reports.length}`,
    );
  }

  for (const issue of issues) {
    if (!returnedNumbers.has(issue.number)) {
      throw new Error(`missing report for issue_number ${issue.number}`);
    }
  }

  return { reports };
}

function normalizeAuditReport(value: unknown): IssueAuditReport {
  const parsed = value as Partial<IssueAuditReport>;
  if (typeof parsed?.issue_number !== "number") {
    throw new Error("missing issue_number");
  }
  if (typeof parsed.conformant !== "boolean") {
    throw new Error(
      `missing conformant for issue_number ${parsed.issue_number}`,
    );
  }

  const proposedBody =
    typeof parsed.proposed_body === "string" &&
    parsed.proposed_body.trim().length > 0
      ? parsed.proposed_body
      : undefined;

  return {
    issue_number: parsed.issue_number,
    conformant: parsed.conformant,
    missing_sections: normalizeAuditStrings(parsed.missing_sections),
    forbidden_sections: normalizeAuditStrings(parsed.forbidden_sections),
    empty_sections: normalizeAuditStrings(parsed.empty_sections),
    quality_issues: normalizeAuditStrings(parsed.quality_issues),
    proposed_body: proposedBody,
  };
}

function normalizeAuditStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

async function clearAuditFindings(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  const existing = await findAuditComment(client, owner, repo, issueNumber);
  if (existing) {
    await client.deleteIssueComment(owner, repo, existing.id);
  }
}

async function findAuditComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ id: number; body: string } | undefined> {
  const comments = await client.listIssueComments(owner, repo, issueNumber);
  return comments.find((c) => c.body.startsWith("<!-- superfield-audit -->"));
}

function chunkIssues(issues: Issue[], batchSize: number): Issue[][] {
  const batches: Issue[][] = [];
  for (let i = 0; i < issues.length; i += batchSize) {
    batches.push(issues.slice(i, i + batchSize));
  }
  return batches;
}
