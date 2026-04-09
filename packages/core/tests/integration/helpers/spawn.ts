import type { AgentOpts, AgentResult } from "../../../agent.ts";

/**
 * Dev-loop scenario spawn helper (stub — implemented in #93).
 *
 * Returns a spawn function that walks the scenario steps in order. Each call
 * inspects the spawned prompt to detect which stage it belongs to (develop vs
 * dev-scout vs ci-failure vs self-audit) and returns the next matching
 * fixture, layering `overrides` on top of the parsed fixture JSON. If a stage
 * is requested out of order or the scenario is exhausted, throws with a clear
 * error so tests fail loudly rather than silently replaying stale data.
 */

export type DevLoopStage =
  | "develop"
  | "dev-scout"
  | "ci-failure"
  | "self-audit";

export interface ScenarioStep {
  stage: DevLoopStage;
  fixture: string;
  /**
   * Optional override for the parsed JSON to inject test-specific signals
   * (e.g. `needsBlueprintEscalation: true`). Layered on top of the fixture.
   */
  overrides?: Record<string, unknown>;
}

export type DevLoopScenario = ScenarioStep[];

export type SpawnFn = (opts: AgentOpts) => Promise<AgentResult>;

export function replayDevLoopSpawn(_scenario: DevLoopScenario): SpawnFn {
  throw new Error("not implemented — see #93");
}
