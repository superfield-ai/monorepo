/**
 * @file sync.ts
 *
 * GitHub → local DB sync service.
 *
 * On startup and on a configurable interval, fetches open GitHub issues and
 * upserts them into the project-local `.superfield/issues.json` store.
 *
 * Required env vars:
 *   GITHUB_TOKEN  — personal access token or GitHub App installation token
 *   GITHUB_REPO   — "owner/repo" (e.g. "acme/my-app")
 *
 * Both vars are optional: when either is absent the sync silently no-ops so
 * the server still starts without GitHub credentials configured.
 */

import { GitHubClient } from "@superfield/github";
import {
  openIssueStore,
  resolveIssueDbPath,
  type LocalIssueRecord,
} from "@superfield/db";
import { logBackend, logBackendError } from "./debug-events";

function parseRepo(
  repoEnv: string,
): { owner: string; repo: string } | null {
  const parts = repoEnv.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

async function syncOnce(projectRoot?: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repoEnv = process.env.GITHUB_REPO;
  if (!token || !repoEnv) return;

  const parsed = parseRepo(repoEnv);
  if (!parsed) {
    logBackend(
      "warn",
      "sync",
      `Invalid GITHUB_REPO "${repoEnv}" — expected "owner/repo"`,
    );
    return;
  }
  const { owner, repo } = parsed;

  try {
    const client = new GitHubClient(token);
    const issues = await client.listIssues(owner, repo);
    const store = await openIssueStore(resolveIssueDbPath(projectRoot));

    for (const issue of issues) {
      const existing = await store.get(issue.number);
      const status: LocalIssueRecord["status"] =
        existing?.status ?? (issue.state === "open" ? "open" : "done");

      const record: LocalIssueRecord = {
        repo: repoEnv,
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        status,
        acceptance: existing?.acceptance ?? [],
        testPlan: existing?.testPlan ?? [],
        githubIssueNumber: issue.number,
        githubIssueUrl: issue.html_url,
        prNumber: existing?.prNumber,
        prUrl: existing?.prUrl,
        syncedAt: new Date().toISOString(),
        updatedAt: existing?.updatedAt ?? new Date().toISOString(),
        metadata: existing?.metadata,
      };
      await store.upsert(record);
    }

    logBackend(
      "info",
      "sync",
      `Synced ${issues.length} issues from ${repoEnv}`,
    );
  } catch (err) {
    logBackendError(err, "sync");
  }
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

export function startSync(
  projectRoot?: string,
  intervalMs = 5 * 60 * 1000,
): void {
  void syncOnce(projectRoot);
  syncTimer = setInterval(() => void syncOnce(projectRoot), intervalMs);
}

export function stopSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

export async function triggerSync(projectRoot?: string): Promise<void> {
  await syncOnce(projectRoot);
}

export { parseRepo };
