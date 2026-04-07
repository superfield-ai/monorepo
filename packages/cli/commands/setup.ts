import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig } from '@superfield/core';

export async function setupCommand(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const handle = await rl.question('GitHub username: ');
    const token = await rl.question('Personal access token (PAT): ');

    const config = await loadConfig();
    const existing = config.users.findIndex((u) => u.handle === handle.trim());

    if (existing >= 0) {
      config.users[existing].token = token.trim();
      console.log(`Updated token for ${handle.trim()}.`);
    } else {
      config.users.push({ handle: handle.trim(), token: token.trim() });
      console.log(`Added user ${handle.trim()}.`);
    }

    await saveConfig(config);
  } finally {
    rl.close();
  }
}
