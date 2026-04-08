import { liveDescribe, liveIt } from '../helpers/live.ts';

/**
 * Layer 3 — live smoke test against the real `claude` CLI.
 *
 * Skipped unless SUPERFIELD_LIVE_CLAUDE=1 is set. Runs nightly or before
 * a release. See docs/testing.md §Layer 3.
 */
liveDescribe('runIssueAudit live', () => {
  liveIt.todo('produces parseable JSON for a real well-formed issue');
  liveIt.todo('flags missing sections on a deliberately malformed issue');
});
