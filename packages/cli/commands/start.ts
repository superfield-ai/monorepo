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

type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export interface StartDeps {
  loadConfig?: () => Promise<Config>;
  resolveRepo?: (dir: string) => Promise<{ owner: string; repo: string }>;
  runPlanningLoop?: (config: Config) => Promise<void>;
  runDevLoop?: (opts: DevLoopOpts) => Promise<void>;
  runDocLoop?: (opts: DocLoopOpts) => Promise<void>;
  createClient?: (token: string) => DevLoopOpts["client"];
  slotCount?: number;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
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
    createClient = (token) => new GitHubClient(token),
    slotCount,
    env = process.env,
    log = console.log,
    warn = console.warn,
    error = console.error,
    exit = process.exit,
  } = deps;
  const logLevel = resolveLogLevel(env, warn);
  const emit = (level: LogLevel, message: string): void => {
    const formatted = `[${level}] ${message}`;
    if (level === "error") {
      error(formatted);
      return;
    }
    if (level === "warn") {
      warn(formatted);
      return;
    }
    if (LOG_LEVEL_RANK[level] <= LOG_LEVEL_RANK[logLevel]) {
      log(formatted);
    }
  };

  if (!repoPath) {
    emit("error", "Usage: superfield start <path-to-repo>");
    exit(1);
    return;
  }

  const config = await loadConfig();
  const dir = path.resolve(repoPath);
  emit("debug", `Resolved repository path: ${dir}`);
  const { owner, repo } = await resolveRepo(dir);
  emit("trace", `Resolved origin repository as ${owner}/${repo}`);

  const existing = config.repositories.find(
    (r) => r.owner === owner && r.repo === repo,
  );
  const assignedUser = existing?.assignedUser ?? config.users[0]?.handle;
  const user = config.users.find((u) => u.handle === assignedUser);

  if (!assignedUser || !user) {
    emit("error", "No GitHub users configured. Run `superfield setup` first.");
    exit(1);
    return;
  }

  emit("info", `Starting superfield for ${owner}/${repo} (user: ${assignedUser})`);

  const effectiveConfig: Config = {
    users: config.users,
    repositories: [{ owner, repo, assignedUser }],
  };

  const client = createClient(user.token);
  const worktrees = new WorktreeManager();
  const envSlotCount = slotCount ?? resolveEnvSlotCount(env, emit);
  if (envSlotCount !== undefined) emit("debug", `Using slot count: ${envSlotCount}`);
  else emit("trace", "Using default slot count");
  try {
    const planIssues = await client.listIssues(owner, repo, ["plan"]);
    if (planIssues.length === 0) {
      emit(
        "warn",
        `No open Plan issue found for ${owner}/${repo}; dev loop will stay idle until a plan issue exists`,
      );
    } else {
      const plan = planIssues[0]!;
      emit("info", `Plan issue detected: #${plan.number} ${plan.title}`);
    }
  } catch (err) {
    emit(
      "warn",
      `Unable to verify Plan issue before starting loops: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  emit("info", "Starting planning/dev/doc loops");
  emit(
    "info",
    "Loop cadence: planning=5s, dev(idle)=30s, docs=60s. Set SUPERFIELD_LOG_LEVEL=debug|trace for more detail.",
  );

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
  emit: (level: LogLevel, message: string) => void,
): number | undefined {
  const raw = env.SUPERFIELD_SLOT_COUNT;
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    emit(
      "warn",
      `Ignoring invalid SUPERFIELD_SLOT_COUNT=${JSON.stringify(raw)}; using the default slot count`,
    );
    return undefined;
  }

  return parsed;
}

function resolveLogLevel(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void,
): LogLevel {
  const raw = (env.SUPERFIELD_LOG_LEVEL ?? env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug" || raw === "trace") {
    return raw;
  }
  warn(
    `[warn] Ignoring invalid SUPERFIELD_LOG_LEVEL=${JSON.stringify(
      env.SUPERFIELD_LOG_LEVEL ?? env.LOG_LEVEL,
    )}; using "info"`,
  );
  return "info";
}
