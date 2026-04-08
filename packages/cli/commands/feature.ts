import * as path from "node:path";
import { loadConfig, runFeatureCommand } from "@superfield/core";
import { GitClient } from "@superfield/git";
import { GitHubClient } from "@superfield/github";

export async function featureCommand(
  request?: string,
  repoPath?: string,
): Promise<void> {
  if (!request) {
    console.error('Usage: superfield feature "<description>" [<path>]');
    process.exit(1);
  }

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

  console.log(`Evaluating feature request for ${owner}/${repo}\n`);
  console.log(`Request: ${request}\n`);

  const client = new GitHubClient(user.token);
  const result = await runFeatureCommand({
    client,
    owner,
    repo,
    request,
    cwd: resolvedPath,
  });

  if (result.duplicateOf !== null) {
    console.log(
      `✗ Duplicate of #${result.duplicateOf} — no new issue created.`,
    );
    return;
  }

  console.log(`✓ Created issue #${result.issueCreated}`);
  if (result.planCreated) console.log("✓ Created Plan tracking issue");
  else if (result.planUpdated) console.log("✓ Appended to Plan");
  if (result.blueprintRulesCited.length > 0) {
    console.log(
      `  Blueprint rules cited: ${result.blueprintRulesCited.join(", ")}`,
    );
  }
}
