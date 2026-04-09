import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { WorktreeManager } from "../../../../git/worktree.ts";
import { GitHubClient } from "../../../../github/client.ts";
import {
  tickDevLoop,
  type DevLoopTickResult,
} from "../../../loops/dev-loop.ts";

import { createTestGitRemote } from "./git-remote.ts";
import {
  seedGitHub,
  type GitHubState,
  type SeedGitHubOpts,
} from "./github-msw.ts";
import {
  replayDevLoopSpawn,
  detectStage,
  type DevLoopScenario,
  type DevLoopStage,
} from "./spawn.ts";

/**
 * Dev-loop e2e harness (#93).
 *
 * Composes `createTestGitRemote` + `seedGitHub` + `replayDevLoopSpawn` into a
 * single object with `tickOnce()` / `dispose()` so tests can drive
 * `tickDevLoop` end-to-end without rewiring collaborators per test.
 *
 * The harness owns:
 *   - a tmp root that parents the git-remote fixture and the worktree root
 *   - the MSW server lifecycle (listen in build, close in dispose)
 *   - the scenario cursor via `replayDevLoopSpawn`
 *   - a real `WorktreeManager` pointed at the in-tree git remote
 *   - a real `GitHubClient` — MSW intercepts its Octokit fetches at the
 *     `api.github.com` layer, so the production client is used unmodified.
 *
 * `dispose()` is idempotent and cleans up even if `tickOnce()` throws.
 */

export interface HarnessOpts {
  /** Parent tmp dir. If omitted, a fresh one under `os.tmpdir()` is created. */
  tmpRoot?: string;
  github: SeedGitHubOpts;
  scenario: DevLoopScenario;
  slotCount?: number;
}

export interface RecordedPrompt {
  stage: DevLoopStage;
  prompt: string;
}

export interface DevLoopHarness {
  tickOnce(): Promise<DevLoopTickResult>;
  dispose(): Promise<void>;
  /** Proxy through to the underlying MSW state for test assertions. */
  state: GitHubState;
  worktreeRoot: string;
  /** Exposed so tests that need direct Octokit access can round-trip. */
  owner: string;
  repo: string;
  /**
   * Every prompt seen by the scenario spawn helper, in the order it was
   * spawned. Populated by a recording proxy wired into the harness spawn —
   * test seam only, never touches production code.
   */
  recordedPrompts: RecordedPrompt[];
}

export async function buildDevLoopHarness(
  opts: HarnessOpts,
): Promise<DevLoopHarness> {
  const ownedTmpRoot = !opts.tmpRoot;
  const tmpRoot =
    opts.tmpRoot ??
    (await fsp.mkdtemp(path.join(os.tmpdir(), "superfield-e2e-")));

  let remote: Awaited<ReturnType<typeof createTestGitRemote>> | null = null;
  let seeded: ReturnType<typeof seedGitHub> | null = null;
  let disposed = false;

  const worktreeRoot = path.join(
    tmpRoot,
    `worktrees-${randomBytes(4).toString("hex")}`,
  );

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    if (seeded) {
      try {
        seeded.server.close();
      } catch (err) {
        errors.push(err);
      }
    }
    if (remote) {
      try {
        await remote.dispose();
      } catch (err) {
        errors.push(err);
      }
    }
    try {
      await fsp.rm(worktreeRoot, { recursive: true, force: true });
    } catch (err) {
      errors.push(err);
    }
    if (ownedTmpRoot) {
      try {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      // Surface the first error but don't block cleanup.
      throw errors[0];
    }
  };

  try {
    remote = await createTestGitRemote({
      tmpRoot,
      owner: opts.github.owner,
      repo: opts.github.repo,
    });
    seeded = seedGitHub(opts.github);
    // Bypass requests to the in-tree git remote (127.0.0.1 on an ephemeral
    // port) — isomorphic-git's node http client goes through the same
    // fetch layer MSW intercepts, so we must explicitly let git traffic
    // through and still error loudly on unhandled github.com calls.
    seeded.server.listen({
      onUnhandledRequest: (request, print) => {
        const url = new URL(request.url);
        if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
          return;
        }
        print.error();
        throw new Error(`unhandled request ${request.method} ${request.url}`);
      },
    });

    const client = new GitHubClient("test-token");
    const worktrees = new WorktreeManager({
      root: worktreeRoot,
      baseUrl: remote.baseUrl,
    });
    const innerSpawn = replayDevLoopSpawn(opts.scenario);
    const recordedPrompts: RecordedPrompt[] = [];
    const spawn = async (
      spawnOpts: Parameters<typeof innerSpawn>[0],
    ): ReturnType<typeof innerSpawn> => {
      recordedPrompts.push({
        stage: detectStage(spawnOpts.prompt),
        prompt: spawnOpts.prompt,
      });
      return innerSpawn(spawnOpts);
    };

    const harness: DevLoopHarness = {
      state: seeded.state,
      worktreeRoot,
      owner: opts.github.owner,
      repo: opts.github.repo,
      recordedPrompts,
      tickOnce: () =>
        tickDevLoop({
          client,
          owner: opts.github.owner,
          repo: opts.github.repo,
          token: "test-token",
          worktrees,
          spawn,
          slotCount: opts.slotCount ?? 1,
        }),
      dispose,
    };
    return harness;
  } catch (err) {
    await dispose().catch(() => undefined);
    throw err;
  }
}
