import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentOpts, AgentResult } from "../../agent.ts";

/**
 * Layer 2 helper: load a recorded `claude` JSON response and replay it as a
 * spawn function. See `docs/testing.md` §Layer 2.
 *
 * Fixtures live in `tests/fixtures/claude/<name>.json` and are committed to
 * the repo. Capture them with `bun record-claude-fixtures <task>`.
 */

const DEFAULT_FIXTURES_DIR = path.resolve(
  import.meta.dirname,
  "../../../../tests/fixtures/claude",
);

export interface ClaudeFixture {
  sessionId: string;
  output: string;
  isError?: boolean;
  costUsd?: number;
  needsBlueprintEscalation?: boolean;
  /** Recording metadata; ignored by replaySpawn. */
  _metadata?: {
    captured_at?: string;
    prompt_builder?: string;
    scenario?: string;
    input_summary?: string;
    hand_authored?: boolean;
  };
}

export async function loadClaudeFixture(
  name: string,
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
): Promise<ClaudeFixture> {
  const filePath = path.join(fixturesDir, `${name}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
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
    needsBlueprintEscalation: fixture.needsBlueprintEscalation,
  });
}

/**
 * Sequence multiple recorded fixtures into a single spawn function. Each
 * spawn invocation consumes the next fixture in order; the last fixture is
 * reused for any further calls. Useful for integration tests that drive a
 * step which makes multiple LLM calls (e.g. feature-evaluate then narrow).
 */
export async function replaySpawnSequence(
  names: string[],
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
): Promise<(opts: AgentOpts) => Promise<AgentResult>> {
  if (names.length === 0) {
    throw new Error("replaySpawnSequence requires at least one fixture name");
  }
  const fixtures = await Promise.all(
    names.map((n) => loadClaudeFixture(n, fixturesDir)),
  );
  let i = 0;
  return async (_opts: AgentOpts) => {
    const f = fixtures[Math.min(i, fixtures.length - 1)]!;
    i++;
    return {
      sessionId: f.sessionId,
      output: f.output,
      isError: f.isError ?? false,
      costUsd: f.costUsd,
      needsBlueprintEscalation: f.needsBlueprintEscalation,
    };
  };
}
