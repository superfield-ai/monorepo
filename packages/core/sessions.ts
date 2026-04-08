import type { GitHubClientPort as GitHubClient } from "@superfield/github";

export type AgentRole = "primary" | "speculative";

export interface AgentSession {
  sessionId: string;
  role: AgentRole;
  slot: number;
  startedAt: string;
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
): Promise<
  Array<{ issueNumber: number; session: AgentSession; commentId: number }>
> {
  const issues = await client.listIssues(owner, repo);
  const stale: Array<{
    issueNumber: number;
    session: AgentSession;
    commentId: number;
  }> = [];
  const now = Date.now();

  for (const issue of issues) {
    const found = await getSession(client, owner, repo, issue.number);
    if (!found) continue;
    const age = now - new Date(found.session.startedAt).getTime();
    if (age > timeoutMs) {
      stale.push({ issueNumber: issue.number, ...found });
    }
  }

  return stale;
}
