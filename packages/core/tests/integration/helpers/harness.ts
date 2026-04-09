import type { DevLoopTickResult } from "../../../loops/dev-loop.ts";
import type { GitHubState, SeedGitHubOpts } from "./github-msw.ts";
import type { DevLoopScenario } from "./spawn.ts";

/**
 * Dev-loop e2e harness (stub — implemented in #93).
 *
 * Composes `createTestGitRemote` + `seedGitHub` + `replayDevLoopSpawn` into a
 * single object with `tickOnce()` / `dispose()` so tests can drive
 * `tickDevLoop` end-to-end without rewiring collaborators per test. The
 * harness owns the tmp worktree root, the MSW server lifecycle, and the
 * scenario cursor; tests just build one, call `tickOnce()` as many times as
 * they need, and read from `state` for assertions.
 */

export interface HarnessOpts {
  tmpRoot: string;
  github: SeedGitHubOpts;
  scenario: DevLoopScenario;
  slotCount?: number;
}

export interface DevLoopHarness {
  tickOnce(): Promise<DevLoopTickResult>;
  dispose(): Promise<void>;
  /** Proxy through to the underlying MSW state for test assertions. */
  state: GitHubState;
  worktreeRoot: string;
}

export async function buildDevLoopHarness(
  _opts: HarnessOpts,
): Promise<DevLoopHarness> {
  throw new Error("not implemented — see #93");
}
