import { githubCommand } from './commands/github.ts';
import { startCommand } from './commands/start.ts';
import { planCommand } from './commands/plan.ts';
import { BUILD_COMMIT, BUILD_DATE, BUILD_VERSION } from './build-info.ts';

function usage(): string {
  return `
superfield — GitOps AI orchestrator

Version: ${BUILD_VERSION}
Commit: ${BUILD_COMMIT}
Build date: ${BUILD_DATE}

Commands:
  github add    Authenticate and register a repository
  github forget Remove credentials and print app uninstall link
  start         Begin the continuous development loop
  plan          Replan: group issues into phases, create scouts, write Plan
`.trim();
}

export async function runCLI(args: string[]): Promise<void> {
  const [cmd, sub, third] = args;

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(usage());
    return;
  }

  if (cmd === 'github') {
    await githubCommand(sub, third);
    return;
  }

  if (cmd === 'start') {
    await startCommand(sub);
    return;
  }

  if (cmd === 'plan') {
    await planCommand(sub);
    return;
  }

  console.log(usage());
  process.exit(cmd ? 1 : 0);
}
