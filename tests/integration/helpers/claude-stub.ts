/**
 * @file tests/integration/helpers/claude-stub.ts
 *
 * Install the Claude bash stub on PATH for Layer 3 integration tests.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Mocked Claude CLI" section.
 *
 * ## Purpose
 *
 * Layer 3 integration tests run the real Calypso stack inside k3s but replace
 * the Claude CLI with a lightweight bash stub. The stub:
 *
 *   1. Appends all invocation arguments to `$CLAUDE_STUB_LOG`.
 *   2. Echoes a deterministic test response.
 *
 * This allows tests to assert what arguments the studio server passed to
 * Claude without making any real LLM calls.
 *
 * ## How it works
 *
 * `installClaudeStub` copies `tests/fixtures/claude-stub` to a unique temp
 * directory and prepends that directory to the test process's `PATH`. Any
 * subsequent `spawn('claude', …)` call from the code under test will find
 * the stub instead of a real claude binary.
 *
 * ## Usage
 *
 * ```ts
 * import { installClaudeStub, type ClaudeStub } from './helpers/claude-stub';
 *
 * let stub: ClaudeStub;
 * beforeAll(async () => {
 *   stub = await installClaudeStub();
 * });
 * afterAll(() => stub.cleanup());
 *
 * it('invokes claude with the user message', async () => {
 *   // … POST /studio/chat …
 *   const log = await stub.readLog();
 *   assert.ok(log.includes('hello world'));
 * });
 * ```
 *
 * ## Integration points
 *
 * - `tests/fixtures/claude-stub` must be executable (`chmod +x`).
 * - `CLAUDE_STUB_LOG` env var must be set before the studio server process
 *   starts so the server inherits it.
 * - The stub dir must be cleaned up in `afterAll` to avoid temp file leaks.
 *
 * ## Risks
 *
 * - On macOS, `mkdtempSync` places the temp dir outside `/private/tmp`; bash
 *   stubs still work but the path may appear differently in logs.
 * - PATH mutation affects the entire test process. Tests that need the real
 *   claude binary should restore `process.env.PATH` from `stub.originalPath`.
 */

import { mkdtempSync, copyFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/** Repository root — two levels up from tests/integration/helpers/. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const STUB_SOURCE = join(REPO_ROOT, 'tests', 'fixtures', 'claude-stub');

export interface ClaudeStub {
  /** Absolute path to the temp directory containing the stub binary. */
  binDir: string;
  /** Absolute path of the log file the stub appends to. */
  logPath: string;
  /** The original `PATH` before installation, for restoration if needed. */
  originalPath: string;
  /** Read the stub invocation log file as a string. */
  readLog(): string;
  /** Remove temp directory and restore PATH. */
  cleanup(): void;
}

/**
 * Copy the Claude bash stub to a temp directory and prepend it to `PATH`.
 *
 * Sets `CLAUDE_STUB_LOG` to a unique temp file path and stores it in the
 * returned handle so tests can read the log after each chat turn.
 */
export function installClaudeStub(): ClaudeStub {
  const binDir = mkdtempSync(join(tmpdir(), 'calypso-claude-stub-'));
  const stubDest = join(binDir, 'claude');

  copyFileSync(STUB_SOURCE, stubDest);
  chmodSync(stubDest, 0o755);

  const logPath = join(binDir, 'claude-stub.log');
  const originalPath = process.env.PATH ?? '';

  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.CLAUDE_STUB_LOG = logPath;

  return {
    binDir,
    logPath,
    originalPath,
    readLog(): string {
      try {
        return readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    },
    cleanup(): void {
      process.env.PATH = originalPath;
      try {
        rmSync(binDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    },
  };
}
