import * as path from "node:path";
import {
  loadConfig as defaultLoadConfig,
  runPlanningLoop as defaultRunPlanningLoop,
  initFileLogger,
  currentLogFile,
} from "@superfield/core";
import { runDevLoop as defaultRunDevLoop } from "@superfield/core/loops/dev-loop";
import { runDocLoop as defaultRunDocLoop } from "@superfield/core/loops/doc-loop";
import { GitHubClient } from "@superfield/github";
import { GitClient, WorktreeManager } from "@superfield/git";
import type { Config } from "@superfield/core";
import type { DevLoopOpts } from "@superfield/core/loops/dev-loop";
import type { DocLoopOpts } from "@superfield/core/loops/doc-loop";
import { ApiState } from "@superfield/core/api-state";
import { startApiServer } from "@superfield/core/api-server";

type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
export type StartLoop = "plan" | "dev" | "doc";
const DEFAULT_LOOPS: StartLoop[] = ["plan", "dev", "doc"];

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
  runPlanningLoop?: (
    config: Config,
    opts?: { apiState?: ApiState },
  ) => Promise<void>;
  runDevLoop?: (opts: DevLoopOpts) => Promise<void>;
  runDocLoop?: (opts: DocLoopOpts) => Promise<void>;
  createClient?: (token: string) => DevLoopOpts["client"];
  loops?: StartLoop[];
  slotCount?: number;
  noApi?: boolean;
  apiPort?: number;
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
    loops = DEFAULT_LOOPS,
    slotCount,
    noApi = false,
    apiPort = 7837,
    env = process.env,
    log = console.log,
    warn = console.warn,
    error = console.error,
    exit = process.exit,
  } = deps;
  const logLevel = resolveLogLevel(env, warn);
  initFileLogger();
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

  emit(
    "info",
    `[start] Starting superfield (user: ${assignedUser}) log=${currentLogFile() ?? "none"}`,
  );

  const effectiveConfig: Config = {
    users: config.users,
    repositories: [{ owner, repo, assignedUser }],
  };

  const client = createClient(user.token);
  const selectedLoops = normalizeLoops(loops);
  const worktrees = new WorktreeManager();
  const envSlotCount = slotCount ?? resolveEnvSlotCount(env, emit);
  if (envSlotCount !== undefined)
    emit("debug", `Using slot count: ${envSlotCount}`);
  else emit("trace", "Using default slot count");
  if (selectedLoops.includes("dev")) {
    let planIssue: { number: number; title: string } | null = null;
    try {
      planIssue = await findOpenPlanIssue(client, owner, repo);
    } catch (err) {
      emit("error", `[start] Failed to read open issues: ${formatError(err)}`);
      exit(1);
      return;
    }
    if (!planIssue) {
      emit(
        "error",
        `No open Plan issue found for ${owner}/${repo}. Run 'superfield plan <repo-path>' first.`,
      );
      exit(1);
      return;
    }
    emit(
      "info",
      `[start] Plan issue detected: #${planIssue.number} ${planIssue.title}`,
    );
  }
  emit("info", `[start] Starting loops: ${selectedLoops.join(", ")}`);
  emit(
    "info",
    "[start] Loop cadence: plan=5s, dev(idle)=30s, doc=60s. Set SUPERFIELD_LOG_LEVEL=debug|trace for more detail.",
  );

  const apiState = new ApiState();
  if (!noApi) {
    const apiLogger = {
      currentLevel: "info" as const,
      emit: (
        level: "error" | "warn" | "info" | "debug" | "trace",
        message: string,
      ) => emit(level, message),
    };
    startApiServer({
      port: apiPort,
      state: apiState,
      logger: apiLogger,
      logDir: currentLogFile() ? path.dirname(currentLogFile()) : config.logDir,
    });
  }

  const tasks: Array<Promise<void>> = [];
  if (selectedLoops.includes("plan")) {
    tasks.push(runPlanningLoop(effectiveConfig, { apiState }));
  }
  if (selectedLoops.includes("dev")) {
    tasks.push(
      runDevLoop({
        client,
        owner,
        repo,
        token: user.token,
        worktrees,
        apiState,
        ...(envSlotCount !== undefined ? { slotCount: envSlotCount } : {}),
      }),
    );
  }
  if (selectedLoops.includes("doc")) {
    tasks.push(runDocLoop({ client, owner, repo, repoPath: dir, apiState }));
  }
  await Promise.all(tasks);
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
  const raw = (
    env.SUPERFIELD_LOG_LEVEL ??
    env.LOG_LEVEL ??
    "info"
  ).toLowerCase();
  if (
    raw === "error" ||
    raw === "warn" ||
    raw === "info" ||
    raw === "debug" ||
    raw === "trace"
  ) {
    return raw;
  }
  warn(
    `[warn] Ignoring invalid SUPERFIELD_LOG_LEVEL=${JSON.stringify(
      env.SUPERFIELD_LOG_LEVEL ?? env.LOG_LEVEL,
    )}; using "info"`,
  );
  return "info";
}

function normalizeLoops(loops: StartLoop[]): StartLoop[] {
  const set = new Set<StartLoop>(loops);
  return DEFAULT_LOOPS.filter((loop) => set.has(loop));
}

async function findOpenPlanIssue(
  client: DevLoopOpts["client"],
  owner: string,
  repo: string,
): Promise<{ number: number; title: string } | null> {
  const allOpenIssues = (await client.listIssues(owner, repo)) ?? [];
  const planIssue = allOpenIssues.find(
    (issue) =>
      issue.labels.some((label) => label.toLowerCase() === "plan") ||
      /^plan\b/i.test(issue.title),
  );
  if (planIssue) return { number: planIssue.number, title: planIssue.title };

  // Backward-compatible fallback for adapters/mocks that only respect
  // label-filtered issue listing.
  if (allOpenIssues.length === 0) {
    const labeledPlanIssues =
      (await client.listIssues(owner, repo, ["plan"])) ?? [];
    const first = labeledPlanIssues[0];
    if (first) return { number: first.number, title: first.title };
  }
  return null;
}

function formatError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (
    /rate limit exceeded|api rate limit exceeded|too many requests|secondary rate limit/i.test(
      singleLine,
    )
  ) {
    const requestId = /request id ([A-Z0-9:]+)/i.exec(singleLine)?.[1];
    return requestId
      ? `GitHub API rate limit exceeded (request id: ${requestId})`
      : "GitHub API rate limit exceeded";
  }
  return singleLine;
}
