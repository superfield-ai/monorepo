import * as path from "node:path";
import {
  loadConfig as defaultLoadConfig,
  runPlanningLoop as defaultRunPlanningLoop,
} from "@superfield/core";
import { runDevLoop as defaultRunDevLoop } from "@superfield/core/loops/dev-loop";
import { runDocLoop as defaultRunDocLoop } from "@superfield/core/loops/doc-loop";
import { GitHubClient } from "@superfield/github";
import { GitClient, WorktreeManager } from "@superfield/git";
import type { Config } from "@superfield/core";
import type { DevLoopOpts } from "@superfield/core/loops/dev-loop";
import type { DocLoopOpts } from "@superfield/core/loops/doc-loop";

export interface StartDeps {
  loadConfig?: () => Promise<Config>;
  resolveRepo?: (dir: string) => Promise<{ owner: string; repo: string }>;
  runPlanningLoop?: (config: Config) => Promise<void>;
  runDevLoop?: (opts: DevLoopOpts) => Promise<void>;
  runDocLoop?: (opts: DocLoopOpts) => Promise<void>;
  slotCount?: number;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  exit?: (code: number) => never;
}

export async function startCommand(
  repoPath: string | undefined,
  deps: StartDeps = {},
): Promise<void> {
  const {
    loadConfig = defaultLoadConfig,
    resolveRepo = defaultResolveRepo,
    runPlanningLoop = defaultRunPlanningLoop,
    runDevLoop = defaultRunDevLoop,
    runDocLoop = defaultRunDocLoop,
    slotCount,
    env = process.env,
    log = console.log,
    error = console.error,
    exit = process.exit,
  } = deps;

  if (!repoPath) {
    error("Usage: superfield start <path-to-repo>");
    exit(1);
    return;
  }

  const config = await loadConfig();
  const dir = path.resolve(repoPath);
  const { owner, repo } = await resolveRepo(dir);

  const existing = config.repositories.find(
    (r) => r.owner === owner && r.repo === repo,
  );
  const assignedUser = existing?.assignedUser ?? config.users[0]?.handle;
  const user = config.users.find((u) => u.handle === assignedUser);

  if (!assignedUser || !user) {
    error("No GitHub users configured. Run `superfield setup` first.");
    exit(1);
    return;
  }

  log(`Starting superfield for ${owner}/${repo} (user: ${assignedUser})\n`);

  const effectiveConfig: Config = {
    users: config.users,
    repositories: [{ owner, repo, assignedUser }],
  };

  const client = new GitHubClient(user.token);
  const worktrees = new WorktreeManager();
  const envSlotCount = slotCount ?? resolveEnvSlotCount(env, error);

  await Promise.all([
    runPlanningLoop(effectiveConfig),
    runDevLoop({
      client,
      owner,
      repo,
      token: user.token,
      worktrees,
      ...(envSlotCount !== undefined ? { slotCount: envSlotCount } : {}),
    }),
    runDocLoop({ client, owner, repo, repoPath: dir }),
  ]);
}

async function defaultResolveRepo(
  dir: string,
): Promise<{ owner: string; repo: string }> {
  const gitClient = new GitClient();
  return gitClient.readRemoteOwnerRepo(dir);
}

function resolveEnvSlotCount(
  env: NodeJS.ProcessEnv,
  error: (msg: string) => void,
): number | undefined {
  const raw = env.SUPERFIELD_SLOT_COUNT;
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    error(
      `Ignoring invalid SUPERFIELD_SLOT_COUNT=${JSON.stringify(raw)}; using the default slot count`,
    );
    return undefined;
  }

  return parsed;
}
