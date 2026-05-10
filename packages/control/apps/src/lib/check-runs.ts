/**
 * @file check-runs.ts
 *
 * Shared types for GitHub check-run data (C-11).
 *
 * CheckRun objects are polled from /analytics/check-runs?sha=<sha> and
 * consumed by CheckRunBadge (TurnTimeline.tsx) and TestOutputPane
 * (VisualDiffPanel.tsx).
 */

/** Minimal shape of one GitHub check-run returned by /analytics/check-runs. */
export interface CheckRun {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: string | null;
  readonly output?: {
    readonly title?: string;
    readonly summary?: string;
    readonly text?: string;
  };
}

/** Shape of the /analytics/check-runs response body. */
export interface CheckRunsResponse {
  readonly checkRuns: readonly CheckRun[];
}

/** Aggregate CI status derived from a list of check-runs. */
export type CheckRunStatus = "pass" | "fail" | "running" | "unknown";

/**
 * Derive a single aggregate status from a list of check-runs.
 *
 * Rules:
 *  - Empty list → "unknown"
 *  - Any run not completed → "running"
 *  - Any failure/timed_out → "fail"
 *  - All success/skipped → "pass"
 *  - Otherwise → "unknown"
 */
export function aggregateCheckRunStatus(
  runs: readonly CheckRun[],
): CheckRunStatus {
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.status !== "completed")) return "running";
  if (
    runs.some(
      (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
    )
  )
    return "fail";
  if (
    runs.every(
      (r) => r.conclusion === "success" || r.conclusion === "skipped",
    )
  )
    return "pass";
  return "unknown";
}
