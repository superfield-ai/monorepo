import type { GitHubClientPort as GitHubClient } from "@superfield/github";

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

/**
 * Creates or updates the session comment on the issue.
 * Called when an agent claims an issue and on each resumption.
 */
export async function upsertSession(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  session: AgentSession,
): Promise<void> {
  const body = `${MARKER}\n${JSON.stringify(session, null, 2)}\n${MARKER_END}`;
  const existing = await getSession(client, owner, repo, issueNumber);
  if (existing) {
    await client.updateIssueComment(owner, repo, existing.commentId, body);
  } else {
    await client.createIssueComment(owner, repo, issueNumber, body);
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
