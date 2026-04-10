import type { GitHubClientPort as GitHubClient } from "@superfield/github";
import type { BlueprintViolation } from "./steps/blueprint-conformance.ts";

const logger = { warn: (...args: unknown[]) => console.warn(...args) };

export type AgentRole = "primary" | "speculative";

export interface AgentSession {
  sessionId: string;
  role: AgentRole;
  slot: number;
  startedAt: string;
  /**
   * One-shot escalation latch (#78). Set to true after the agent first
   * returns `needsBlueprintEscalation: true`. Once latched, subsequent
   * dev-loop turns on this issue always build the prompt with the
   * expanded blueprint context fragment and never re-escalate.
   */
  blueprintEscalated?: boolean;
  /**
   * Pre-PR blueprint self-audit remediation count (#81). Incremented every
   * time the self-audit returns a `conformant: false` verdict. Capped at 3
   * remediation passes per issue — on the 4th non-conformant verdict the
   * dev-loop logs an error and exits the slot without opening a PR.
   *
   * Persists across dev-loop restarts via the session comment so a crash
   * mid-remediation does not silently reset the counter.
   */
  selfAuditRemediationCount?: number;
  /**
   * Violations from the most recent non-conformant self-audit (#81). The
   * next develop turn injects them into the prompt under "Pending
   * blueprint remediation" so the agent has explicit fix instructions.
   * Cleared once the audit returns conformant.
   */
  selfAuditPendingViolations?: BlueprintViolation[];
  /**
   * Monotonic optimistic-locking version (#103). Incremented on every
   * successful upsert. Legacy comments without this field parse as 0.
   */
  version?: number;
}

export interface IssueSession {
  issueNumber: number;
  session: AgentSession;
  commentId: number;
}

export interface StartupSessionClassification {
  prioritizedSessions: IssueSession[];
  prioritizedIssueNumbers: number[];
  reapedSessions: IssueSession[];
  reapedIssueNumbers: number[];
}

const MARKER = "<!-- superfield-session:";
const MARKER_END = "-->";

/**
 * Returns the session comment for an issue, or null if none exists.
 * The comment body format is:
 *   <!-- superfield-session:
 *   {"sessionId":"...","role":"primary","slot":1,"startedAt":"..."}
 *   -->
 */
export async function getSession(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ session: AgentSession; commentId: number } | null> {
  const comments = await client.listIssueComments(owner, repo, issueNumber);
  for (const comment of comments) {
    if (!comment.body.startsWith(MARKER)) continue;
    const jsonStart = comment.body.indexOf("\n") + 1;
    const jsonEnd = comment.body.lastIndexOf(MARKER_END);
    if (jsonEnd < 0) continue;
    try {
      const session = JSON.parse(
        comment.body.slice(jsonStart, jsonEnd).trim(),
      ) as AgentSession;
      // Legacy comments without a version field default to 0.
      if (session.version === undefined) session.version = 0;
      return { session, commentId: comment.id };
    } catch {
      // malformed — skip
    }
  }
  return null;
}

/**
 * Enumerates open issues that currently carry a forge-stored agent session.
 * This is the discovery seam the dev loop can use on startup before deciding
 * whether sessions are stale, resumable, or orphaned.
 */
export async function findIssuesWithSessions(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<IssueSession[]> {
  const issues = await client.listIssues(owner, repo);
  const sessions: IssueSession[] = [];

  for (const issue of issues) {
    const found = await getSession(client, owner, repo, issue.number);
    if (!found) continue;
    sessions.push({ issueNumber: issue.number, ...found });
  }

  return sessions;
}

/**
 * Classifies forge-stored sessions for the dev loop's one-time startup scan.
 *
 * - Non-stale sessions whose issues still exist in the current Plan are
 *   resumable and returned in Plan order.
 * - Stale sessions are reaped.
 * - Fresh sessions on issues not present in the current Plan are also reaped.
 */
export async function classifyStartupSessions(
  client: GitHubClient,
  owner: string,
  repo: string,
  planIssueNumbers: number[],
  timeoutMs: number,
): Promise<StartupSessionClassification> {
  const now = Date.now();
  const planOrder = new Map(
    planIssueNumbers.map((issueNumber, index) => [issueNumber, index]),
  );
  const prioritizedSessions: IssueSession[] = [];
  const reapedSessions: IssueSession[] = [];

  for (const found of await findIssuesWithSessions(client, owner, repo)) {
    const age = now - new Date(found.session.startedAt).getTime();
    const planIndex = planOrder.get(found.issueNumber);
    if (age > timeoutMs || planIndex === undefined) {
      reapedSessions.push(found);
      continue;
    }
    prioritizedSessions.push(found);
  }

  prioritizedSessions.sort(
    (a, b) =>
      (planOrder.get(a.issueNumber) ?? Number.MAX_SAFE_INTEGER) -
      (planOrder.get(b.issueNumber) ?? Number.MAX_SAFE_INTEGER),
  );

  return {
    prioritizedSessions,
    prioritizedIssueNumbers: prioritizedSessions.map((s) => s.issueNumber),
    reapedSessions,
    reapedIssueNumbers: reapedSessions.map((s) => s.issueNumber),
  };
}

/** Exponential backoff delays for optimistic-locking retries. */
const RETRY_DELAYS_MS = [100, 200, 400];

/**
 * Creates or updates the session comment on the issue.
 * Called when an agent claims an issue and on each resumption.
 *
 * Uses optimistic locking via a monotonic `version` field to detect
 * concurrent writes. On conflict the full read-modify-write cycle is
 * retried up to 3 times with exponential backoff. If conflicts persist,
 * the write proceeds anyway (last-writer-wins — no worse than before).
 */
export async function upsertSession(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  session: AgentSession,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const existing = await getSession(client, owner, repo, issueNumber);
    const expectedVersion = existing?.session.version ?? 0;
    const nextVersion = expectedVersion + 1;

    const stamped = { ...session, version: nextVersion };
    const body = `${MARKER}\n${JSON.stringify(stamped, null, 2)}\n${MARKER_END}`;

    if (!existing) {
      // No comment yet — create with version 1.
      await client.createIssueComment(owner, repo, issueNumber, body);
      return;
    }

    // Re-read to detect interleaved writes.
    const recheck = await getSession(client, owner, repo, issueNumber);
    const storedVersion = recheck?.session.version ?? 0;

    if (storedVersion > expectedVersion) {
      // Conflict detected — another writer incremented the version.
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt]!;
        logger.warn(
          `[sessions] version conflict on issue #${issueNumber} ` +
            `(expected ${expectedVersion}, found ${storedVersion}), ` +
            `retry ${attempt + 1}/${RETRY_DELAYS_MS.length} after ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue; // retry full cycle
      }
      // Exhausted retries — fall through and write anyway.
      logger.warn(
        `[sessions] exhausted ${RETRY_DELAYS_MS.length} retries on issue ` +
          `#${issueNumber}, writing anyway (last-writer-wins)`,
      );
    }

    await client.updateIssueComment(owner, repo, existing.commentId, body);
    return;
  }
}

/**
 * Deletes the session comment from the issue.
 * Called when the agent's work is complete and the issue is closed.
 */
export async function deleteSession(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  const existing = await getSession(client, owner, repo, issueNumber);
  if (existing) {
    await client.deleteIssueComment(owner, repo, existing.commentId);
  }
}

/**
 * Scans all open issues for stale session comments (deadman switch).
 * A session is considered stale if startedAt is older than timeoutMs.
 * Returns issue numbers with stale sessions so the orchestrator can re-claim them.
 */
export async function findStaleSessions(
  client: GitHubClient,
  owner: string,
  repo: string,
  timeoutMs: number,
): Promise<IssueSession[]> {
  const stale: IssueSession[] = [];
  const now = Date.now();

  for (const found of await findIssuesWithSessions(client, owner, repo)) {
    const age = now - new Date(found.session.startedAt).getTime();
    if (age > timeoutMs) {
      stale.push(found);
    }
  }

  return stale;
}
