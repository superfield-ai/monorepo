import type { SetupServer } from "msw/node";

/**
 * GitHub MSW seed helper (stub — implemented in #95).
 *
 * The interfaces below capture only the fields that `runSlot`, `tickDevLoop`,
 * `runPrePRSelfAudit`, and `runBlueprintConformance` actually read from
 * GitHub responses — this is intentionally narrower than the full REST API so
 * downstream fixtures stay small and stable. #95 will wire an MSW
 * `setupServer` against `api.github.com` that serves these seed structures
 * and mutates `GitHubState` in response to PATCH/POST calls.
 */

export interface SeedComment {
  id?: number;
  body: string;
}

export interface SeedIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments?: SeedComment[];
}

export interface SeedPR {
  number: number;
  issueNumber: number;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
}

export interface SeedCheck {
  sha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | null;
}

export interface SeedGitHubOpts {
  owner: string;
  repo: string;
  planBody: string;
  issues?: SeedIssue[];
  prs?: SeedPR[];
  checks?: SeedCheck[];
}

export interface GitHubState {
  getIssue(n: number): SeedIssue | undefined;
  getComments(issueNumber: number): SeedComment[];
  getPRForIssue(issueNumber: number): SeedPR | undefined;
}

export interface SeededGitHub {
  server: SetupServer;
  state: GitHubState;
}

export function seedGitHub(_opts: SeedGitHubOpts): SeededGitHub {
  throw new Error("not implemented — see #95");
}
