import { describe, it } from "vitest";

/**
 * Layer 3 helper: gate live `claude` smoke tests behind the
 * `SUPERFIELD_LIVE_CLAUDE` env var. See `docs/testing.md` §Layer 3.
 */

export function isLiveMode(): boolean {
  return Boolean(
    process.env.SUPERFIELD_LIVE_CLAUDE &&
    process.env.SUPERFIELD_LIVE_CLAUDE !== "",
  );
}

/**
 * Marks the surrounding describe block as live-only. When live mode is
 * disabled, the entire suite is silently skipped. When enabled, it runs
 * normally and may spawn the real `claude` CLI.
 *
 * Typed loosely because vitest's `describe.skip` is a chainable function
 * with a different surface than `describe`. Both have call signatures
 * compatible with `(name, fn) => void`, which is all consumers need.
 */
export const liveDescribe = (
  isLiveMode() ? describe : describe.skip
) as typeof describe;
export const liveIt = (isLiveMode() ? it : it.skip) as typeof it;
