/**
 * Pinned environment for deterministic git operations across runs.
 *
 * The harness MUST NOT inherit:
 *   - the developer's `~/.gitconfig` (would leak signing config, aliases,
 *     and arbitrary user-merge tools into the lane)
 *   - the system git config (same hazard, system-wide)
 *   - locale-dependent settings that affect text comparison
 *   - timezone-dependent commit dates
 *
 * The pinned author/committer identity is constant so commit SHAs are
 * reproducible across machines for the same fixture.
 */

/**
 * 2025-01-01T00:00:00Z. A fixed past instant — its absolute value is
 * irrelevant; what matters is that it never changes between runs.
 */
export const PINNED_DATE = '1735689600 +0000';

export const PINNED_AUTHOR_NAME = 'Sharp Test Harness';
export const PINNED_AUTHOR_EMAIL = 'harness@sharp.test';

/**
 * Build a sanitized environment for invoking `git`. Returns a fresh object;
 * mutating it has no effect on subsequent calls.
 */
export function buildPinnedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    // Block discovery of any developer-side config.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',

    // Pinned identity for reproducible commit hashes.
    GIT_AUTHOR_NAME: PINNED_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: PINNED_AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: PINNED_DATE,
    GIT_COMMITTER_NAME: PINNED_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: PINNED_AUTHOR_EMAIL,
    GIT_COMMITTER_DATE: PINNED_DATE,

    // Locale neutralization.
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',

    // Make git refuse to use a credential helper or prompt for credentials.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',

    // Preserve PATH so the runtime can find the binaries we expect.
    PATH: process.env.PATH ?? '',
    // HOME is required by some tools but must not point at the developer's
    // real home. Callers are expected to set this to a tmpdir; default to
    // /tmp as a last resort so a missing HOME doesn't crash a tool.
    HOME: '/tmp',

    ...extra,
  };
}
