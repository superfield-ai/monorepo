import { describe, it } from "vitest";
import type { AgentBackend } from "../../agent.ts";

const SUPPORTED_BACKENDS: AgentBackend[] = ["claude", "codex"];

/**
 * Layer 3 helper: gate live agent smoke tests behind the
 * `SUPERFIELD_LIVE_AGENTS` env var. See `docs/testing.md` §Layer 3.
 */

export function isLiveMode(): boolean {
  return Boolean(
    process.env.SUPERFIELD_LIVE_AGENTS &&
    process.env.SUPERFIELD_LIVE_AGENTS !== "",
  );
}

export function liveBackends(): AgentBackend[] {
  const raw = process.env.SUPERFIELD_LIVE_AGENTS?.trim();
  if (!raw || raw === "1" || raw.toLowerCase() === "all") {
    return SUPPORTED_BACKENDS;
  }

  const wanted = new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  return SUPPORTED_BACKENDS.filter((backend) => wanted.has(backend));
}

/**
 * Marks the surrounding describe block as live-only. When live mode is
 * disabled, the entire suite is silently skipped. When enabled, it runs
 * normally and may spawn the real agent CLIs.
 *
 * Typed loosely because vitest's `describe.skip` is a chainable function
 * with a different surface than `describe`. Both have call signatures
 * compatible with `(name, fn) => void`, which is all consumers need.
 */
export const liveDescribe = (
  isLiveMode() ? describe : describe.skip
) as typeof describe;
export const liveIt = (isLiveMode() ? it : it.skip) as typeof it;
