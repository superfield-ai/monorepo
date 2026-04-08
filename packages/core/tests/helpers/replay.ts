import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentOpts, AgentResult } from '../../agent.ts';

/**
 * Layer 2 helper: load a recorded `claude` JSON response and replay it as a
 * spawn function. See `docs/testing.md` §Layer 2.
 *
 * Fixtures live in `tests/fixtures/claude/<name>.json` and are committed to
 * the repo. Capture them with `bun record-claude-fixtures <task>`.
 */

const DEFAULT_FIXTURES_DIR = path.resolve(
  import.meta.dirname,
  '../../../../tests/fixtures/claude',
);

export interface ClaudeFixture {
  sessionId: string;
  output: string;
  isError?: boolean;
  costUsd?: number;
  /** Recording metadata; ignored by replaySpawn. */
  _metadata?: {
    captured_at?: string;
    prompt_builder?: string;
    input_summary?: string;
  };
}

export async function loadClaudeFixture(
  name: string,
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
): Promise<ClaudeFixture> {
  const filePath = path.join(fixturesDir, `${name}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Claude fixture not found: ${name} (looked in ${filePath}). ` +
        `Record it with: bun record-claude-fixtures ${name}`,
    );
  }
  return JSON.parse(raw) as ClaudeFixture;
}

export async function replaySpawn(
  name: string,
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
): Promise<(opts: AgentOpts) => Promise<AgentResult>> {
  const fixture = await loadClaudeFixture(name, fixturesDir);
  return async (_opts: AgentOpts) => ({
    sessionId: fixture.sessionId,
    output: fixture.output,
    isError: fixture.isError ?? false,
    costUsd: fixture.costUsd,
  });
}
