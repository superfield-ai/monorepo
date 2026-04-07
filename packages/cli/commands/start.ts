import { loadConfig } from '@superfield/core';
import { runOuterLoop } from '@superfield/core/loop';

export async function startCommand(): Promise<void> {
  const config = await loadConfig();

  if (config.repositories.length === 0) {
    console.error('No repositories configured. Run `superfield repo add` first.');
    process.exit(1);
  }

  console.log(`Starting superfield for ${config.repositories.length} repository(s). Ctrl-C to stop.\n`);
  await runOuterLoop(config);
}
