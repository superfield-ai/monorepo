/**
 * @file screenshot-hook.ts
 *
 * Real implementation of the Studio turn-completion screenshot hook (issue #249).
 *
 * ## Integration
 *
 * This module exports `onTurnComplete`, which matches the signature of the
 * `DevLoopOpts.onTurnComplete` callback added to `packages/core/loops/dev-loop.ts`.
 *
 * The CLI's `start` command should pass this hook when studio mode is active
 * (i.e. when `CONTROL_PORT` or `SUPERFIELD_REPO_ROOT` is set):
 *
 * ```ts
 * import { onTurnComplete } from "@superfield/control/screenshot-hook";
 * runDevLoop({ ..., onTurnComplete });
 * ```
 *
 * ## Screenshot path
 *
 *   docs/studio-sessions/<sessionId>/turn-<N>.png
 *
 * relative to SUPERFIELD_REPO_ROOT (or process.cwd() when unset).
 *
 * ## Canonical docs
 *
 * - docs/prd.md §Studio observability
 * - docs/plan.md — issue #249
 *
 * @see packages/control/src/screenshot-capture.ts  — Playwright runner
 * @see packages/core/loops/dev-loop.ts             — hook call site
 */

import type { TurnCompletionContext } from "@superfield/core/loops/dev-loop";
import { captureScreenshot } from "./screenshot-capture";
import { REPO_ROOT } from "./agent";

export type { TurnCompletionContext };

/**
 * Turn-completion hook — triggers a headless screenshot of the app preview.
 *
 * Called by the dev loop after each agent turn.  The function is best-effort:
 * any error is logged and swallowed so a failed screenshot never disrupts the
 * dev loop.
 */
export async function onTurnComplete(ctx: TurnCompletionContext): Promise<void> {
  const path = await captureScreenshot({
    sessionId: ctx.sessionId,
    repoRoot: REPO_ROOT,
  });
  if (path) {
    console.log(
      `[screenshot] captured turn-${ctx.slot} for session ${ctx.sessionId}: ${path}`,
    );
  }
}
