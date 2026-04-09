/**
 * Integration-test helpers barrel.
 *
 * Re-exports the three test seams used by the tickDevLoop harness so tests
 * can pull everything from one import path.
 */

export {
  seedGitHub,
  type SeedGitHubOpts,
  type SeedIssue,
  type SeedPR,
  type SeedCheck,
  type SeedComment,
  type SeededGitHub,
  type GitHubState,
  type StoredComment,
} from "./github-msw.ts";

export { createTestGitRemote, seedCommitsOnRemote } from "./git-remote.ts";

export { replayDevLoopSpawn } from "./spawn.ts";
export type {
  DevLoopScenario,
  DevLoopStage,
  ScenarioStep,
  SpawnFn,
} from "./spawn.ts";

export { buildDevLoopHarness } from "./harness.ts";
export type { DevLoopHarness, HarnessOpts, RecordedPrompt } from "./harness.ts";
