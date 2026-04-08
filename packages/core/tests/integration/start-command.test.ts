import { describe, it } from 'vitest';

/**
 * Integration test for the not-yet-wired `superfield start` orchestration.
 *
 * Currently `startCommand` only launches the planning loop. The remaining
 * work in docs/plan.md "Remaining cross-cutting work" is to wire all three
 * loops together via Promise.all.
 *
 * Goal: assert that `runStart` invokes runPlanningLoop, runDevLoop, and
 * runDocLoop concurrently against the same config and shares the GitHub
 * client cleanly. The actual loops are stubbed via injected fakes.
 *
 * See docs/testing.md §Layer 2 and docs/plan.md §Remaining cross-cutting work.
 */
describe('start command — wires all three loops', () => {
  it.todo('runs planning loop, dev loop, and doc loop concurrently');
  it.todo('exits cleanly when SIGINT is received');
  it.todo('logs each loop tick to stdout');
  it.todo('survives a single tick failure in one loop without killing the others');
});
