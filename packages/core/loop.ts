import type { Config } from './config.ts';
import { GitHubClient } from '@superfield/github';
import { hasFailedChecks, runWatchdog } from './watchdog.ts';

const POLL_INTERVAL_MS = 5_000;

export async function runOuterLoop(config: Config): Promise<void> {
  while (true) {
    await Promise.all(config.repositories.map((repoConfig) => {
      const user = config.users.find((u) => u.handle === repoConfig.assignedUser);
      if (!user) {
        console.error(`No user configured for ${repoConfig.owner}/${repoConfig.repo}`);
        return Promise.resolve();
      }
      const client = new GitHubClient(user.token);
      return tickRepository(client, repoConfig.owner, repoConfig.repo);
    }));
    await sleep(POLL_INTERVAL_MS);
  }
}

async function tickRepository(client: GitHubClient, owner: string, repo: string): Promise<void> {
  const sha = await client.getHeadSha(owner, repo);
  const runs = await client.getCheckRuns(owner, repo, sha);
  const failed = hasFailedChecks(runs);

  for (const run of failed) {
    const result = await runWatchdog(client, owner, repo, sha, run);
    if (result.issueCreated) {
      console.log(`[${owner}/${repo}] Created issue #${result.issue!.number}: ${result.issue!.title}`);
    } else if (result.skipped) {
      console.log(`[${owner}/${repo}] Skipped ${run.name}: ${result.reason}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
