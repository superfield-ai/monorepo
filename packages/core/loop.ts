import type { Config } from "./config.ts";
import { GitHubClient } from "@superfield/github";
import type { GitHubClientPort, Issue } from "@superfield/github";
import { createHash } from "node:crypto";
import {
  buildCIFailureIssueBody,
  buildCIFailureIssueTitle,
  buildCIFailurePlanEntry,
  hasFailedChecks,
} from "./watchdog.ts";
import {
  runPlanCoverage,
  type PlanCoverageResult,
} from "./steps/plan-coverage.ts";
import {
  listAuditableIssues,
  runIssueAudit,
  type IssueAuditResult,
} from "./steps/issue-audit.ts";
import {
  runBlueprintConformance,
  type BlueprintConformanceResult,
} from "./steps/blueprint-conformance.ts";
import { runSupervisedLoop } from "./supervised-loop.ts";
import { insertCIFailureAtTop, parsePlan, serializePlan } from "./plan.ts";
import { formatError, isRateLimitError } from "./format-error.ts";

const POLL_INTERVAL_MS = 5_000;
const ISSUE_AUDIT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const PLAN_ISSUE_AUDIT_STATE_MARKER = "<!-- superfield-plan-issue-audit-state -->";

interface IssueAuditStateEntry {
  fingerprint: string;
  auditedAtMs: number;
  nonConformant: boolean;
}

/**
 * The planning loop — one of three concurrent loops inside `superfield start`.
 *
 * Runs every 5 seconds per configured repository:
 *   1. CI watchdog — detect failed checks, create ci-failure issues,
 *      insert at top of Plan
 *   2. Issue audit — validate open issues against the IssueBody schema
 *   3. Plan coverage — append any open issues not yet referenced in Plan
 *   4. Blueprint conformance — advisory check against blueprint rules
 *
 * See PRD §Command: start §Planning loop.
 */
export async function runPlanningLoop(config: Config): Promise<void> {
  console.log(
    `[plan] loop started for ${config.repositories.length} repository(ies)`,
  );
  await runSupervisedLoop({
    runOnce: async () => {
      console.log("[plan] tick start");
      await tickConfiguredRepositories(config);
    },
    delayMs: () => POLL_INTERVAL_MS,
    onError: (err) => {
      console.error(`[error] [plan] loop failed: ${formatError(err)}`);
    },
  });
}

/** Structured outcome of a single planning-loop tick per repository. */
export interface TickRepositoryResult {
  /** Issues created by the CI watchdog in this tick. */
  watchdogIssuesCreated: number[];
  watchdog:
    | { ok: true; issuesCreated: number[] }
    | { ok: false; error: string; issuesCreated: number[] };
  issueAudit:
    | { ok: true; nonConformant: number[] }
    | { ok: false; error: string };
  planCoverage:
    | {
        ok: true;
        appended: number[];
        skipped: number[];
        llmPlaced: number[];
        createdPhases: string[];
        planCreated: boolean;
      }
    | { ok: false; error: string };
  blueprintConformance:
    | { ok: true; issuesWithViolations: number[] }
    | { ok: false; error: string };
}

/** Injectable step functions — used in unit tests to avoid spawning the LLM. */
export interface TickRepositoryOpts {
  issueAudit?: (
    client: GitHubClientPort,
    owner: string,
    repo: string,
    opts: object,
  ) => Promise<IssueAuditResult>;
  blueprintConformance?: (
    client: GitHubClientPort,
    owner: string,
    repo: string,
    opts: object,
  ) => Promise<BlueprintConformanceResult>;
  planCoverage?: (
    client: GitHubClientPort,
    owner: string,
    repo: string,
    opts: { issues?: Issue[] },
  ) => Promise<PlanCoverageResult>;
}

export interface PlanningLoopTickOpts {
  createClient?: (token: string) => GitHubClientPort;
  tickRepository?: (
    client: GitHubClientPort,
    owner: string,
    repo: string,
  ) => Promise<TickRepositoryResult>;
}

async function tickRepository(
  client: GitHubClientPort,
  owner: string,
  repo: string,
  opts: TickRepositoryOpts = {},
): Promise<TickRepositoryResult> {
  const auditFn = opts.issueAudit ?? runIssueAudit;
  const blueprintFn = opts.blueprintConformance ?? runBlueprintConformance;
  const coverageFn = opts.planCoverage ?? runPlanCoverage;
  let allOpenIssues: Issue[] | null = null;

  // Step 1: CI watchdog
  let watchdogOutcome: TickRepositoryResult["watchdog"];
  let watchdogIssuesCreated: number[] = [];
  try {
    watchdogIssuesCreated = await runWatchdogStep(client, owner, repo);
    watchdogOutcome = { ok: true, issuesCreated: watchdogIssuesCreated };
  } catch (err) {
    const msg = formatError(err);
    watchdogOutcome = { ok: false, error: msg, issuesCreated: [] };
    console.error(`[error] [plan] watchdog failed: ${msg}`);
    if (isRateLimitError(msg)) {
      return {
        watchdogIssuesCreated,
        watchdog: watchdogOutcome,
        issueAudit: { ok: false, error: "skipped due to GitHub rate limit" },
        planCoverage: { ok: false, error: "skipped due to GitHub rate limit" },
        blueprintConformance: {
          ok: false,
          error: "skipped due to GitHub rate limit",
        },
      };
    }
  }

  // Step 2: Issue audit — validate open issues against the IssueBody schema
  let issueAuditOutcome: TickRepositoryResult["issueAudit"];
  try {
    allOpenIssues = await client.listIssues(owner, repo);
    // Only enable cache-driven incremental audit in production path.
    // Tests inject custom issueAudit fns and should remain deterministic.
    if (!opts.issueAudit) {
      const auditable = listAuditableIssues(allOpenIssues);
      if (auditable.length === 0) {
        issueAuditOutcome = { ok: true, nonConformant: [] };
      } else {
      const planIssue = findPlanIssue(allOpenIssues);
      const loadedState = planIssue
        ? await loadPlanIssueAuditState(
            client,
            owner,
            repo,
            planIssue.number,
          )
        : { entries: new Map<number, IssueAuditStateEntry>() };
      const {
        issuesToAudit,
        cachedNonConformant,
        skippedRecentlyAudited,
      } = selectIssuesToAuditFromState(
        auditable,
        loadedState.entries,
        Date.now(),
      );
      if (planIssue) {
        console.log(
          `[plan] issue-audit state: plan=#${planIssue.number} cached=${loadedState.entries.size} to_audit=${issuesToAudit.length} skipped=${skippedRecentlyAudited}`,
        );
      }

      if (issuesToAudit.length === 0) {
        issueAuditOutcome = {
          ok: true,
          nonConformant: cachedNonConformant,
        };
      } else {
        const audit = await auditFn(client, owner, repo, {
          cwd: process.cwd(),
          issues: issuesToAudit,
        });
        mergeIssueAuditState(
          loadedState.entries,
          auditable,
          issuesToAudit,
          audit,
          Date.now(),
        );
        if (planIssue) {
          await persistPlanIssueAuditState(
            client,
            owner,
            repo,
            planIssue.number,
            loadedState.entries,
            loadedState.commentId,
            loadedState.commentBody,
          );
        }
        issueAuditOutcome = {
          ok: true,
          nonConformant: Array.from(
            new Set([...cachedNonConformant, ...audit.nonConformant]),
          ),
        };
      }

      if (skippedRecentlyAudited > 0) {
        console.log(
          `[plan] issue-audit: skipped ${skippedRecentlyAudited} recently-audited unchanged issue(s)`,
        );
      }
      if (issueAuditOutcome.nonConformant.length > 0) {
        console.log(
          `[plan] issue audit: ${issueAuditOutcome.nonConformant.length} non-conformant issue(s): ${issueAuditOutcome.nonConformant.join(", ")}`,
        );
      }
      }
    } else {
      const audit = await auditFn(client, owner, repo, {
        cwd: process.cwd(),
        issues: allOpenIssues,
      });
      issueAuditOutcome = { ok: true, nonConformant: audit.nonConformant };
      if (audit.nonConformant.length > 0) {
        console.log(
          `[plan] issue audit: ${audit.nonConformant.length} non-conformant issue(s): ${audit.nonConformant.join(", ")}`,
        );
      }
    }
  } catch (err) {
    const msg = formatError(err);
    issueAuditOutcome = { ok: false, error: msg };
    console.error(`[error] [plan] issue-audit failed: ${msg}`);
    if (isRateLimitError(msg)) {
      return {
        watchdogIssuesCreated,
        watchdog: watchdogOutcome!,
        issueAudit: issueAuditOutcome,
        planCoverage: { ok: false, error: "skipped due to GitHub rate limit" },
        blueprintConformance: {
          ok: false,
          error: "skipped due to GitHub rate limit",
        },
      };
    }
  }

  // Step 3: Plan coverage — append open issues not yet referenced in Plan
  let planCoverageOutcome: TickRepositoryResult["planCoverage"];
  try {
    const coverage = await coverageFn(client, owner, repo, {
      issues: allOpenIssues ?? undefined,
    });
    planCoverageOutcome = {
      ok: true,
      appended: coverage.appended,
      skipped: coverage.skipped,
      llmPlaced: coverage.llmPlaced,
      createdPhases: coverage.createdPhases,
      planCreated: coverage.planCreated,
    };
    if (coverage.planCreated) {
      console.log("[plan] Created Plan tracking issue");
    }
    if (coverage.appended.length > 0) {
      console.log(
        `[plan] Appended ${coverage.appended.length} issues to Plan: ${coverage.appended.join(", ")}`,
      );
    }
    if (coverage.llmPlaced.length > 0) {
      console.log(
        `[plan] LLM placed ${coverage.llmPlaced.length} issue(s): ${coverage.llmPlaced.join(", ")}`,
      );
    }
    if (coverage.createdPhases.length > 0) {
      console.log(
        `[plan] Created ${coverage.createdPhases.length} phase(s): ${coverage.createdPhases.join(", ")}`,
      );
    }
    if (coverage.skipped.length > 0) {
      console.log(
        `[plan] Deferred ${coverage.skipped.length} issue(s) pending scout-gated placement: ${coverage.skipped.join(", ")}`,
      );
    }
  } catch (err) {
    const msg = formatError(err);
    planCoverageOutcome = { ok: false, error: msg };
    console.error(`[error] [plan] plan-coverage failed: ${msg}`);
    if (isRateLimitError(msg)) {
      return {
        watchdogIssuesCreated,
        watchdog: watchdogOutcome!,
        issueAudit: issueAuditOutcome!,
        planCoverage: planCoverageOutcome,
        blueprintConformance: {
          ok: false,
          error: "skipped due to GitHub rate limit",
        },
      };
    }
  }

  // Step 4: Blueprint conformance — advisory check of issues against blueprint rules
  let blueprintConformanceOutcome: TickRepositoryResult["blueprintConformance"];
  try {
    const conformance = await blueprintFn(client, owner, repo, {
      cwd: process.cwd(),
      issues: allOpenIssues ?? undefined,
    });
    blueprintConformanceOutcome = {
      ok: true,
      issuesWithViolations: conformance.issuesWithViolations,
    };
    if (conformance.issuesWithViolations.length > 0) {
      console.log(
        `[plan] Blueprint conformance: violations on issue(s) ${conformance.issuesWithViolations.join(", ")}`,
      );
    }
  } catch (err) {
    const msg = formatError(err);
    blueprintConformanceOutcome = { ok: false, error: msg };
    console.error(
      `[error] [plan] blueprint-conformance failed: ${msg}`,
    );
  }

  return {
    watchdogIssuesCreated,
    watchdog: watchdogOutcome,
    issueAudit: issueAuditOutcome!,
    planCoverage: planCoverageOutcome!,
    blueprintConformance: blueprintConformanceOutcome!,
  };
}

/**
 * Exported for unit testing only — drives a single tick without the while(true) loop.
 * @internal
 */
export { tickRepository as tickRepositoryForTesting };

async function tickConfiguredRepositories(
  config: Config,
  opts: PlanningLoopTickOpts = {},
): Promise<void> {
  const createClient =
    opts.createClient ?? ((token) => new GitHubClient(token));
  const tickRepositoryFn = opts.tickRepository ?? tickRepository;

  await Promise.all(
    config.repositories.map(async (repoConfig) => {
      const user = config.users.find(
        (candidate) => candidate.handle === repoConfig.assignedUser,
      );
      if (!user) {
        console.error(
          `No user configured for ${repoConfig.owner}/${repoConfig.repo}`,
        );
        return;
      }

      try {
        const result = await tickRepositoryFn(
          createClient(user.token),
          repoConfig.owner,
          repoConfig.repo,
        );
        const auditSummary = result.issueAudit.ok
          ? `${result.issueAudit.nonConformant.length} non-conformant`
          : "error";
        const coverageSummary = result.planCoverage.ok
          ? `${result.planCoverage.appended.length} appended, ${(result.planCoverage.skipped ?? []).length} skipped`
          : "error";
        const conformanceSummary = result.blueprintConformance.ok
          ? `${result.blueprintConformance.issuesWithViolations.length} with violations`
          : "error";
        console.log(
          `[plan] tick complete: watchdog=${result.watchdogIssuesCreated.length}, issueAudit=${auditSummary}, planCoverage=${coverageSummary}, blueprint=${conformanceSummary}`,
        );
      } catch (err) {
        const msg = formatError(err);
        console.error(
          `[error] [plan] tick failed: ${msg}`,
        );
      }
    }),
  );
}

export { tickConfiguredRepositories as tickConfiguredRepositoriesForTesting };

async function runWatchdogStep(
  client: GitHubClientPort,
  owner: string,
  repo: string,
): Promise<number[]> {
  const watchdogIssuesCreated: number[] = [];
  const sha = await client.getHeadSha(owner, repo);
  const runs = await client.getCheckRuns(owner, repo, sha);
  const failed = hasFailedChecks(runs);
  if (failed.length === 0) return watchdogIssuesCreated;

  const openIssues = await client.listIssues(owner, repo);
  const existingFailureTitles = new Set(
    openIssues
      .filter((issue) => issue.labels.includes("ci-failure"))
      .map((issue) => issue.title),
  );
  const planIssue = openIssues.find(
    (issue) =>
      issue.labels.includes("plan") || /^plan\b/i.test(issue.title),
  );
  let plan = parsePlan(planIssue?.body ?? "");
  let planChanged = false;

  for (const run of failed) {
    const shortSha = sha.slice(0, 7);
    const title = buildCIFailureIssueTitle(repo, run.name, shortSha);
    if (existingFailureTitles.has(title)) {
      console.log(`[plan] Skipped ${run.name}: duplicate ci-failure issue`);
      continue;
    }

    const body = buildCIFailureIssueBody(run.name, sha, run.html_url);
    const issue = await client.createIssue({
      owner,
      repo,
      title,
      body,
      labels: ["ci-failure", "watchdog"],
    });
    existingFailureTitles.add(title);
    watchdogIssuesCreated.push(issue.number);
    plan = insertCIFailureAtTop(plan, buildCIFailurePlanEntry(issue.number, title));
    planChanged = true;
    console.log(
      `[plan] Created issue #${issue.number}: ${issue.title}`,
    );
  }

  if (planChanged) {
    const planBody = serializePlan(plan);
    if (planIssue) {
      await client.updateIssueBody({
        owner,
        repo,
        issue_number: planIssue.number,
        body: planBody,
      });
    } else {
      await client.createIssue({
        owner,
        repo,
        title: "Plan",
        body: planBody,
        labels: ["plan"],
      });
      console.log("[plan] Created Plan tracking issue");
    }
  }

  return watchdogIssuesCreated;
}

function findPlanIssue(issues: Issue[]): Issue | null {
  return (
    issues.find(
      (issue) =>
        issue.labels.includes("plan") || /^plan\b/i.test(issue.title),
    ) ?? null
  );
}

function fingerprintIssue(issue: Issue): string {
  const sortedLabels = issue.labels.slice().sort();
  return createHash("sha1")
    .update(
      JSON.stringify({
        title: issue.title,
        body: issue.body ?? "",
        labels: sortedLabels,
        state: issue.state,
      }),
    )
    .digest("hex");
}

function selectIssuesToAuditFromState(
  issues: Issue[],
  state: Map<number, IssueAuditStateEntry>,
  nowMs: number,
): {
  issuesToAudit: Issue[];
  cachedNonConformant: number[];
  skippedRecentlyAudited: number;
} {
  const issuesToAudit: Issue[] = [];
  const cachedNonConformant: number[] = [];
  let skippedRecentlyAudited = 0;

  for (const issue of issues) {
    const fingerprint = fingerprintIssue(issue);
    const cached = state.get(issue.number);
    if (!cached) {
      issuesToAudit.push(issue);
      continue;
    }
    const unchanged = cached.fingerprint === fingerprint;
    const fresh =
      nowMs - cached.auditedAtMs < ISSUE_AUDIT_MIN_INTERVAL_MS;
    if (unchanged && fresh) {
      skippedRecentlyAudited += 1;
      if (cached.nonConformant) cachedNonConformant.push(issue.number);
      continue;
    }
    issuesToAudit.push(issue);
  }

  return { issuesToAudit, cachedNonConformant, skippedRecentlyAudited };
}

function mergeIssueAuditState(
  state: Map<number, IssueAuditStateEntry>,
  auditableIssues: Issue[],
  auditedIssues: Issue[],
  auditResult: IssueAuditResult,
  nowMs: number,
): void {
  const active = new Set(auditableIssues.map((issue) => issue.number));
  for (const issueNumber of Array.from(state.keys())) {
    if (!active.has(issueNumber)) state.delete(issueNumber);
  }

  for (const issue of auditedIssues) {
    const report = auditResult.reports[issue.number];
    if (!report) continue;
    state.set(issue.number, {
      fingerprint: fingerprintIssue(issue),
      auditedAtMs: nowMs,
      nonConformant: !report.conformant,
    });
  }
}

async function loadPlanIssueAuditState(
  client: GitHubClientPort,
  owner: string,
  repo: string,
  planIssueNumber: number,
): Promise<{
  entries: Map<number, IssueAuditStateEntry>;
  commentId?: number;
  commentBody?: string;
}> {
  const comments = await client.listIssueComments(owner, repo, planIssueNumber);
  const stateComment = comments.find((comment) =>
    comment.body.startsWith(PLAN_ISSUE_AUDIT_STATE_MARKER),
  );
  if (!stateComment) return { entries: new Map<number, IssueAuditStateEntry>() };

  const jsonText = stateComment.body
    .slice(PLAN_ISSUE_AUDIT_STATE_MARKER.length)
    .trim();
  if (!jsonText) {
    return {
      entries: new Map<number, IssueAuditStateEntry>(),
      commentId: stateComment.id,
      commentBody: stateComment.body,
    };
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      issues?: Array<{
        number: number;
        fingerprint: string;
        audited_at_ms: number;
        non_conformant: boolean;
      }>;
    };
    const entries = new Map<number, IssueAuditStateEntry>();
    for (const item of parsed.issues ?? []) {
      if (
        typeof item.number !== "number" ||
        typeof item.fingerprint !== "string" ||
        typeof item.audited_at_ms !== "number" ||
        typeof item.non_conformant !== "boolean"
      ) {
        continue;
      }
      entries.set(item.number, {
        fingerprint: item.fingerprint,
        auditedAtMs: item.audited_at_ms,
        nonConformant: item.non_conformant,
      });
    }
    return {
      entries,
      commentId: stateComment.id,
      commentBody: stateComment.body,
    };
  } catch {
    return {
      entries: new Map<number, IssueAuditStateEntry>(),
      commentId: stateComment.id,
      commentBody: stateComment.body,
    };
  }
}

function serializePlanIssueAuditState(
  entries: Map<number, IssueAuditStateEntry>,
): string {
  const issues = Array.from(entries.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([number, entry]) => ({
      number,
      fingerprint: entry.fingerprint,
      audited_at_ms: entry.auditedAtMs,
      non_conformant: entry.nonConformant,
    }));
  const payload = {
    version: 1,
    min_interval_ms: ISSUE_AUDIT_MIN_INTERVAL_MS,
    updated_at: new Date().toISOString(),
    issues,
  };
  return `${PLAN_ISSUE_AUDIT_STATE_MARKER}\n${JSON.stringify(payload)}`;
}

async function persistPlanIssueAuditState(
  client: GitHubClientPort,
  owner: string,
  repo: string,
  planIssueNumber: number,
  entries: Map<number, IssueAuditStateEntry>,
  existingCommentId?: number,
  existingCommentBody?: string,
): Promise<void> {
  const nextBody = serializePlanIssueAuditState(entries);
  if (existingCommentBody?.trim() === nextBody.trim()) return;
  if (existingCommentId) {
    await client.updateIssueComment(owner, repo, existingCommentId, nextBody);
    return;
  }
  await client.createIssueComment(owner, repo, planIssueNumber, nextBody);
}
