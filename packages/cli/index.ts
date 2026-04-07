import { setupCommand } from './commands/setup.ts';
import { repoAddCommand } from './commands/repo-add.ts';
import { startCommand } from './commands/start.ts';

const USAGE = `
superfield — GitOps AI orchestrator

Commands:
  setup          Add a GitHub user (handle + PAT)
  repo add       Register a repository and assign it to a user
  start          Begin the continuous development loop
`.trim();

export async function runCLI(args: string[]): Promise<void> {
  const [cmd, sub] = args;

  if (cmd === 'setup') {
    await setupCommand();
    return;
  }

  if (cmd === 'repo' && sub === 'add') {
    await repoAddCommand();
    return;
  }

  if (cmd === 'start') {
    await startCommand();
    return;
  }

  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
