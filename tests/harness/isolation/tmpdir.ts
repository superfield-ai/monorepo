/**
 * Per-scenario tmpdir lifecycle.
 *
 * Each scenario runs inside a fresh `mktemp -d` style directory which is
 * removed on exit. If the harness is invoked with --keep-failures, the
 * caller can opt out of cleanup on a per-scenario basis to inspect the
 * working tree of a failed run.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export interface TmpdirHandle {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Create a tmpdir. The caller is responsible for invoking the returned
 * cleanup. Prefer `withScenarioTmpdir` unless the caller has lifetime
 * constraints that don't fit the closure form.
 */
export async function makeScenarioTmpdir(scenarioId: string): Promise<TmpdirHandle> {
  const safe = scenarioId.replaceAll('/', '__').replaceAll(/[^a-zA-Z0-9_]/g, '_');
  const path = await mkdtemp(resolve(tmpdir(), `sharp-test-${safe}-`));
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Run `fn` inside a fresh tmpdir, removing the tmpdir on exit (success or
 * failure) unless `keepOnFailure` is set, in which case a failure leaves
 * the tmpdir on disk for inspection and the caller is responsible for
 * cleanup.
 */
export async function withScenarioTmpdir<T>(
  scenarioId: string,
  fn: (path: string) => Promise<T>,
  opts: { keepOnFailure?: boolean } = {},
): Promise<T> {
  const handle = await makeScenarioTmpdir(scenarioId);
  let failed = false;
  try {
    return await fn(handle.path);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (!(failed && opts.keepOnFailure)) {
      await handle.cleanup();
    }
  }
}
