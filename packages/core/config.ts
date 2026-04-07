import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, stringify } from 'yaml';

export interface GitHubUser {
  handle: string;
  token: string;
}

export interface Repository {
  owner: string;
  repo: string;
  assignedUser: string;
}

export interface Config {
  users: GitHubUser[];
  repositories: Repository[];
}

const CONFIG_PATH = path.join(os.homedir(), '.superfield', 'config.yaml');

function empty(): Config {
  return { users: [], repositories: [] };
}

export async function loadConfig(filePath = CONFIG_PATH): Promise<Config> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = parse(raw) as Partial<Config>;
    return {
      users: parsed.users ?? [],
      repositories: parsed.repositories ?? [],
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw err;
  }
}

export async function saveConfig(config: Config, filePath = CONFIG_PATH): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringify(config), 'utf8');
}
