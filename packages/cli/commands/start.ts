import * as path from 'node:path';
import { loadConfig } from '@superfield/core';
import { runOuterLoop } from '@superfield/core/loop';
import { GitClient } from '@superfield/git';
import type { Config } from '@superfield/core';

export async function startCommand(repoPath?: string): Promise<void> {
  const config = await loadConfig();
  const effectiveConfig = repoPath ? await configFromPath(config, repoPath) : config;

  if (effectiveConfig.repositories.length === 0) {
    console.error('No repositories configured. Run `superfield repo add` first, or pass a repo path.');
    process.exit(1);
  }

  const { owner, repo } = effectiveConfig.repositories[0];
  const label = effectiveConfig.repositories.length === 1
    ? `${owner}/${repo}`
    : `${effectiveConfig.repositories.length} repositories`;

  console.log(`Starting superfield for ${label}. Ctrl-C to stop.\n`);
  await runOuterLoop(effectiveConfig);
}

async function configFromPath(base: Config, repoPath: string): Promise<Config> {
  const dir = path.resolve(repoPath);
  const gitClient = new GitClient();
  const { owner, repo } = await gitClient.readRemoteOwnerRepo(dir);

  // Use a configured user if one is already assigned to this repo,
  // otherwise fall back to the first available user.
  const existing = base.repositories.find((r) => r.owner === owner && r.repo === repo);
  const assignedUser = existing?.assignedUser ?? base.users[0]?.handle;

  if (!assignedUser) {
    console.error('No GitHub users configured. Run `superfield setup` first.');
    process.exit(1);
  }

  console.log(`Resolved ${dir} → ${owner}/${repo} (user: ${assignedUser})\n`);

  return {
    users: base.users,
    repositories: [{ owner, repo, assignedUser }],
  };
}
