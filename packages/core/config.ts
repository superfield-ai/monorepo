import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parse, stringify } from "yaml";

export interface GitHubUser {
  handle: string;
  token: string;
}

export interface Repository {
  owner: string;
  repo: string;
  assignedUser: string;
}

/**
 * One entry in an abstract tier priority list.
 * `backend` matches `AgentBackend`; kept as `string` here to avoid a
 * circular import with agent.ts.
 */
export interface TierEntry {
  backend: string;
  model: string;
}

/**
 * Overrides for the abstract tier priority lists used by the job registry.
 * Keys are abstract tier names (e.g. `"thinking-medium"`).
 * A present key fully replaces the built-in list for that tier.
 */
export type TierTableOverrides = Record<string, TierEntry[]>;

/**
 * Per-job-type spec override as stored in config.
 * A present entry fully replaces the built-in spec for that job type.
 */
export interface ConfigJobSpec {
  preferred: { backend: string; tier: string };
  failovers: Array<{ backend: string; tier: string } | string>;
}

export interface Config {
  users: GitHubUser[];
  repositories: Repository[];
  /**
   * App-wide tier priority table overrides.
   * See `docs/runtime-agent-selection.md` for the full tier catalogue.
   */
  tiers?: TierTableOverrides;
  /**
   * Per-job-type overrides. Keys are job type names (e.g. `"plan"`).
   * A present entry fully replaces the built-in preferred + failover spec.
   */
  jobs?: Record<string, ConfigJobSpec>;
}

const CONFIG_PATH = path.join(os.homedir(), ".superfield", "config.yaml");

function empty(): Config {
  return { users: [], repositories: [] };
}

export async function loadConfig(filePath = CONFIG_PATH): Promise<Config> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parse(raw) as Partial<Config>;
    const config: Config = {
      users: parsed.users ?? [],
      repositories: parsed.repositories ?? [],
    };
    if (parsed.tiers !== undefined) config.tiers = parsed.tiers;
    if (parsed.jobs !== undefined) config.jobs = parsed.jobs;
    return config;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
}

export async function saveConfig(
  config: Config,
  filePath = CONFIG_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringify(config), "utf8");
}
