import type { AgentOpts, AgentResult } from "../../../agent.ts";
import { loadClaudeFixture } from "../../helpers/replay.ts";

/**
 * Dev-loop scenario spawn helper (#93).
 *
 * Returns a spawn function that walks the scenario steps in order. Each call
 * inspects the spawned prompt to detect which stage it belongs to (develop vs
 * dev-scout vs ci-failure vs self-audit) and returns the next matching
 * fixture, layering `overrides` on top of the parsed fixture JSON. If the
 * next scenario step's stage does not match the detected stage, or the
 * scenario is exhausted, throws with a clear error so tests fail loudly
 * rather than silently replaying stale data.
 *
 * Stage detection heuristic (prompts are distinct enough to disambiguate by
 * substring):
 *   - "Pre-PR blueprint self-audit"   → self-audit
 *   - "Assignment: dev-scout"         → dev-scout
 *   - "CI check is failing"           → ci-failure
 *   - anything else                   → develop
 *
 * The optional per-step `act` callback lets tests drive MSW-backed GitHub
 * state mutations (e.g. simulate the agent opening + merging a PR) from
 * inside the spawn, which is how the happy-path test closes the primary
 * issue at exactly the moment runSlot expects it to be closed.
 */

export type DevLoopStage =
  "develop" | "dev-scout" | "ci-failure" | "self-audit";

export interface ScenarioStep {
  stage: DevLoopStage;
  fixture: string;
  /**
   * Optional override for the parsed fixture. Fields set here win over the
   * fixture. Useful for flipping `isError` or injecting a specific
   * `needsBlueprintEscalation` value per step.
   */
  overrides?: Partial<AgentResult>;
  /**
   * Optional side-effect callback invoked synchronously after the fixture
   * has been resolved but before the spawn promise resolves. The callback
   * receives the spawn opts so tests can inspect the actual prompt body,
   * and may drive arbitrary async work (fetch against the MSW-intercepted
   * GitHub API, filesystem writes into `worktreePath`, etc.) to emulate
   * the side-effects a real agent would have performed.
   */
  act?: (ctx: { opts: AgentOpts }) => Promise<void> | void;
}

export type DevLoopScenario = ScenarioStep[];

export type SpawnFn = (opts: AgentOpts) => Promise<AgentResult>;

export function detectStage(prompt: string): DevLoopStage {
  if (prompt.includes("Pre-PR blueprint self-audit")) return "self-audit";
  if (prompt.includes("Assignment: dev-scout")) return "dev-scout";
  if (prompt.includes("CI check is failing")) return "ci-failure";
  return "develop";
}

export function replayDevLoopSpawn(scenario: DevLoopScenario): SpawnFn {
  // Steps are consumed by stage match (FIFO within a stage). Because dev
  // loops run the primary and speculative slots in parallel, two develop
  // spawns can arrive before the first self-audit. We therefore match the
  // next un-consumed step whose stage equals the detected stage instead of
  // requiring strict positional order across stages.
  const steps = scenario.map((s) => ({ step: s, consumed: false }));
  return async (opts: AgentOpts): Promise<AgentResult> => {
    const stage = detectStage(opts.prompt);
    const next = steps.find((e) => !e.consumed && e.step.stage === stage);
    if (!next) {
      throw new Error(
        `replayDevLoopSpawn: no remaining scenario step matches stage "${stage}". ` +
          `Prompt head: ${opts.prompt.slice(0, 120).replace(/\s+/g, " ")}`,
      );
    }
    next.consumed = true;
    const step = next.step;
    const fixture = await loadClaudeFixture(step.fixture);
    const base: AgentResult = {
      sessionId: fixture.sessionId,
      output: fixture.output,
      isError: fixture.isError ?? false,
      costUsd: fixture.costUsd,
      needsBlueprintEscalation: fixture.needsBlueprintEscalation,
    };
    const merged: AgentResult = { ...base, ...(step.overrides ?? {}) };
    if (step.act) await step.act({ opts });
    return merged;
  };
}
