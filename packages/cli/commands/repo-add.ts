import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig } from '@superfield/core';

export async function repoAddCommand(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const config = await loadConfig();

    if (config.users.length === 0) {
      console.error('No users configured. Run `superfield setup` first.');
      process.exit(1);
    }

    const owner = await rl.question('Repository owner (org or user): ');
    const repo = await rl.question('Repository name: ');

    const handles = config.users.map((u) => u.handle).join(', ');
    const assignedUser = await rl.question(`Assign to user [${handles}]: `);

    if (!config.users.find((u) => u.handle === assignedUser.trim())) {
      console.error(`User "${assignedUser.trim()}" not found in config.`);
      process.exit(1);
    }

    const key = `${owner.trim()}/${repo.trim()}`;
    const existing = config.repositories.findIndex(
      (r) => r.owner === owner.trim() && r.repo === repo.trim(),
    );

    if (existing >= 0) {
      config.repositories[existing].assignedUser = assignedUser.trim();
      console.log(`Updated ${key}.`);
    } else {
      config.repositories.push({
        owner: owner.trim(),
        repo: repo.trim(),
        assignedUser: assignedUser.trim(),
      });
      console.log(`Added ${key}.`);
    }

    await saveConfig(config);
  } finally {
    rl.close();
  }
}
