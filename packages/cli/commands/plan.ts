import * as path from "node:path";
import { loadConfig, runPlanCommand } from "@superfield/core";
import { GitClient } from "@superfield/git";
import { GitHubClient } from "@superfield/github";

export async function planCommand(repoPath?: string): Promise<void> {
  const resolvedPath = repoPath ? path.resolve(repoPath) : process.cwd();

  const config = await loadConfig();
  const gitClient = new GitClient();
  const { owner, repo } = await gitClient.readRemoteOwnerRepo(resolvedPath);

  const repoConfig = config.repositories.find(
    (r) => r.owner === owner && r.repo === repo,
  );
  const userHandle = repoConfig?.assignedUser ?? config.users[0]?.handle;
  if (!userHandle) {
    console.error(
      "No GitHub users configured. Run `superfield github add` first.",
    );
    process.exit(1);
  }

  const user = config.users.find((u) => u.handle === userHandle);
  if (!user) {
    console.error(`User @${userHandle} not found in config.`);
    process.exit(1);
  }

  console.log(`Replanning ${owner}/${repo} (user: @${userHandle})\n`);

  const client = new GitHubClient(user.token);
  const result = await runPlanCommand({
    client,
    owner,
    repo,
    cwd: resolvedPath,
  });

  if (result.scoutsCreated.length > 0) {
    console.log(
      `✓ Created ${result.scoutsCreated.length} scout issue(s): ${result.scoutsCreated.map((n) => `#${n}`).join(", ")}`,
    );
  }
  if (result.validationErrors.length > 0) {
    console.error("\n✗ Plan validation failed:");
    for (const err of result.validationErrors) console.error(`  - ${err}`);
    process.exit(1);
  }
  if (result.planCreated) {
    console.log("✓ Created Plan tracking issue");
  } else if (result.planUpdated) {
    console.log("✓ Updated Plan tracking issue");
  } else {
    console.log("No open issues to plan.");
  }
}
