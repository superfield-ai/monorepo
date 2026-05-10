/**
 * @file screenshot-hook.ts
 *
 * No-op stub for the Studio turn-completion screenshot capture hook.
 *
 * ## Dev-scout purpose (issue #280)
 *
 * This file is the integration seam identified by the dev-scout for issues
 * #249 (screenshot capture), #250 (visual diff), and #251 (sparkline /
 * log-filter / heartbeat). Real implementations belong in those issues;
 * this stub ensures the hook point compiles cleanly and establishes the
 * public API contract.
 *
 * ## Turn-completion hook point
 *
 * The canonical turn-completion signal lives in:
 *
 *   packages/core/loops/dev-loop.ts — function `runIssueSlot()`
 *   ~line 886: immediately after `agentResult = await (async () => { ... })();`
 *             and `clearInterval(heartbeatInterval)` executes.
 *
 * At that moment the following fields are available:
 *
 *   - `agentResult.sessionId`   — identifies the session whose turn just ended
 *   - `agentResult.costUsd`     — cost of the completed turn
 *   - `agentResult.isError`     — whether the agent exited non-zero
 *   - `slot`                    — numeric slot index (0 = primary)
 *   - `wt.path`                 — absolute worktree path for file inspection
 *   - `entry.number`            — GitHub issue number being developed
 *
 * The hook should be called there with these values so #249 can trigger a
 * screenshot, #250 can compute a visual diff, and #251 can record the
 * heartbeat/sparkline data point.
 *
 * ## File-overlap map for #249, #250, #251
 *
 * ### Issue #249 — screenshot capture
 *
 * Files to CREATE:
 *   - packages/control/src/screenshot-hook.ts       (this file — replace stub)
 *   - packages/control/src/screenshot-capture.ts    (Puppeteer/Playwright runner)
 *
 * Files to MODIFY:
 *   - packages/core/loops/dev-loop.ts               (call hook after agentResult)
 *   - packages/control/src/router.ts                (add GET /studio/screenshots/:sessionId route)
 *   - packages/control/src/index.ts                 (wire screenshot-capture startup if needed)
 *
 * ### Issue #250 — visual diff
 *
 * Files to CREATE:
 *   - packages/control/apps/src/components/VisualDiffPanel.tsx
 *
 * Files to MODIFY:
 *   - packages/control/apps/src/components/TurnTimeline.tsx   ← OVERLAP with #249
 *     (add diff thumbnail to the turn row / TurnModal)
 *   - packages/control/src/router.ts                          ← OVERLAP with #249
 *     (add GET /studio/screenshots/diff/:beforeId/:afterId route)
 *
 * ### Issue #251 — sparkline / log-filter / heartbeat
 *
 * Files to CREATE:
 *   - packages/control/apps/src/components/TurnSparkline.tsx
 *
 * Files to MODIFY:
 *   - packages/control/apps/src/components/TurnTimeline.tsx   ← OVERLAP with #249, #250
 *     (add sparkline under the turn list)
 *   - packages/control/apps/src/components/OrchestratorView.tsx
 *     (add log-filter input above the log pane)
 *   - packages/control/apps/src/controllers/OrchestratorController.ts
 *     (expose heartbeat history array for sparkline data)
 *
 * ## Overlapping files (shared pressure)
 *
 * | File                              | #249 | #250 | #251 |
 * |-----------------------------------|------|------|------|
 * | TurnTimeline.tsx                  |  ✓   |  ✓   |  ✓   |
 * | router.ts                         |  ✓   |  ✓   |      |
 * | dev-loop.ts                       |  ✓   |      |      |
 * | OrchestratorView.tsx              |      |      |  ✓   |
 * | OrchestratorController.ts         |      |      |  ✓   |
 *
 * TurnTimeline.tsx is the highest-pressure file. #249 must land first (or
 * coordinate) so #250 and #251 can rebase cleanly on top.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §Studio observability
 * - docs/plan.md — issues #249, #250, #251
 */

/**
 * Context passed to the turn-completion screenshot hook.
 *
 * All fields are available at the hook call site in
 * `packages/core/loops/dev-loop.ts#runIssueSlot()`.
 */
export interface TurnCompletionContext {
  /** Agent session identifier. Used to correlate screenshots with turn logs. */
  readonly sessionId: string;
  /** Numeric slot index (0 = primary). */
  readonly slot: number;
  /** GitHub issue number being developed. */
  readonly issueNumber: number;
  /** Absolute path to the issue worktree. */
  readonly worktreePath: string;
  /** Whether the agent turn exited with an error. */
  readonly isError: boolean;
  /** Cost of the completed turn in USD. */
  readonly costUsd: number;
}

/**
 * No-op stub: called after each agent turn completes.
 *
 * #249 replaces this with real Puppeteer/Playwright screenshot logic.
 * Until then the function compiles, imports cleanly, and returns
 * `undefined` without side effects.
 *
 * @param _ctx  Turn-completion context (unused by the stub).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function onTurnComplete(
  _ctx: TurnCompletionContext,
): Promise<void> {
  // no-op — real implementation belongs in issue #249
}
