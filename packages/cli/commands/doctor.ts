import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  loadConfig,
  saveConfig,
  type Config,
  type GitHubUser,
} from "@superfield/core";
import { GitClient } from "@superfield/git";
import { GitHubClient } from "@superfield/github";

export interface DoctorDeps {
  loadConfig: () => Promise<Config>;
  saveConfig: (config: Config) => Promise<void>;
  prompt: (question: string) => Promise<string>;
  resolveRepo: (repoPath: string) => Promise<{ owner: string; repo: string }>;
  authenticateToken: (token: string) => Promise<string | null>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface DoctorReport {
  dirty: boolean;
  unresolved: boolean;
}

export async function doctorCommand(repoPath?: string): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const report = await runDoctor(repoPath, {
      loadConfig,
      saveConfig,
      prompt: (question) => rl.question(question),
      resolveRepo: async (inputPath) => {
        const gitClient = new GitClient();
        return gitClient.readRemoteOwnerRepo(path.resolve(inputPath));
      },
      authenticateToken: async (token) => {
        try {
          const client = new GitHubClient(token);
          const user = await client.getAuthenticatedUser();
          return user.login;
        } catch {
          return null;
        }
      },
      log: console.log,
      error: console.error,
    });

    if (report.unresolved) {
      process.exitCode = 1;
    }
  } finally {
    rl.close();
  }
}

export async function runDoctor(
  repoPath: string | undefined,
  deps: DoctorDeps,
): Promise<DoctorReport> {
  const config = await deps.loadConfig();
  let dirty = false;
  let unresolved = false;
  const repoDirectory = repoPath ? path.resolve(repoPath) : undefined;

  deps.log("superfield doctor\n");

  if (repoDirectory) {
    try {
      const { owner, repo } = await deps.resolveRepo(repoDirectory);
      deps.log(`✓ Repo:   ${owner}/${repo}`);
    } catch {
      deps.error(`✗ Could not read git remote from ${repoDirectory}`);
      deps.error(
        "  Make sure the path is a git repository with an origin remote.\n",
      );
      unresolved = true;
    }
  }

  if (config.users.length === 0) {
    deps.log("✗ No GitHub users configured.\n");
    deps.error(
      "  Run `superfield github add` to sign in with GitHub App device flow.\n",
    );
    unresolved = true;
  }

  if (config.users.length > 0) {
    for (const user of config.users) {
      const result = await verifyUser(user, config.users, deps);
      dirty ||= result.dirty;
      unresolved ||= result.unresolved;
    }

    for (const repo of config.repositories) {
      const assignedUser = config.users.find(
        (user) => user.handle === repo.assignedUser,
      );
      if (assignedUser) {
        deps.log(`✓ Repo:   ${repo.owner}/${repo.repo} → ${repo.assignedUser}`);
        continue;
      }

      deps.error(
        `✗ Repository ${repo.owner}/${repo.repo} is assigned to missing user ${repo.assignedUser}.`,
      );
      const replacement = await chooseAssignedUser(deps, config.users);
      repo.assignedUser = replacement;
      dirty = true;
      deps.log(`  → Reassigned ${repo.owner}/${repo.repo} to ${replacement}.`);
    }
  }

  if (repoDirectory) {
    const repo = await ensureRepoRegistered(repoDirectory, config, deps);
    dirty ||= repo.dirty;
    unresolved ||= repo.unresolved;
  } else if (config.repositories.length === 0) {
    deps.log(
      "No repositories configured yet. Run `superfield github add` to authorize GitHub access.\n",
    );
  }

  if (dirty) {
    await deps.saveConfig(config);
    deps.log("✓ Config saved to ~/.superfield/config.yaml");
  } else {
    deps.log("✓ All checks passed. Nothing to update.");
  }

  if (unresolved) {
    deps.error("\n✗ Doctor finished with unresolved issues.");
  } else {
    deps.log("\n✓ Doctor finished.");
  }

  return { dirty, unresolved };
}

async function verifyUser(
  user: GitHubUser,
  allUsers: GitHubUser[],
  deps: Pick<DoctorDeps, "authenticateToken" | "log" | "error">,
): Promise<{ dirty: boolean; unresolved: boolean }> {
  const originalHandle = user.handle;
  const authenticatedLogin = await deps.authenticateToken(user.token);

  if (!authenticatedLogin) {
    deps.error(`✗ User:   ${originalHandle} (token invalid or expired)`);
    deps.error(
      "  Run `superfield github add` to refresh the GitHub App authorization.",
    );
    return { dirty: false, unresolved: true };
  }

  if (authenticatedLogin !== originalHandle) {
    if (
      allUsers.some(
        (other) => other !== user && other.handle === authenticatedLogin,
      )
    ) {
      deps.error(
        `✗ User:   ${originalHandle} (token valid as ${authenticatedLogin}, but that handle already exists)`,
      );
      return { dirty: false, unresolved: true };
    }

    user.handle = authenticatedLogin;
    deps.log(
      `✓ User:   ${originalHandle} → ${authenticatedLogin} (token valid)`,
    );
    return { dirty: true, unresolved: false };
  }

  deps.log(`✓ User:   ${originalHandle} (token valid)`);
  return { dirty: false, unresolved: false };
}

async function ensureRepoRegistered(
  repoDirectory: string,
  config: Config,
  deps: Pick<DoctorDeps, "resolveRepo" | "prompt" | "log" | "error">,
): Promise<{ dirty: boolean; unresolved: boolean }> {
  const { owner, repo } = await deps.resolveRepo(repoDirectory);
  const existing = config.repositories.find(
    (item) => item.owner === owner && item.repo === repo,
  );

  if (!existing) {
    deps.error(`✗ Repository ${owner}/${repo} is not registered in config.\n`);
    const assignedUser = await chooseAssignedUser(deps, config.users);
    config.repositories.push({ owner, repo, assignedUser });
    deps.log(`  → Added ${owner}/${repo} assigned to ${assignedUser}.`);
    return { dirty: true, unresolved: false };
  }

  if (!config.users.some((user) => user.handle === existing.assignedUser)) {
    deps.error(
      `✗ Repository ${owner}/${repo} is assigned to missing user ${existing.assignedUser}.\n`,
    );
    const assignedUser = await chooseAssignedUser(deps, config.users);
    existing.assignedUser = assignedUser;
    deps.log(`  → Reassigned ${owner}/${repo} to ${assignedUser}.`);
    return { dirty: true, unresolved: false };
  }

  deps.log(`✓ Repo:   ${owner}/${repo} → ${existing.assignedUser}`);
  return { dirty: false, unresolved: false };
}

async function chooseAssignedUser(
  deps: Pick<DoctorDeps, "prompt" | "error">,
  users: GitHubUser[],
): Promise<string> {
  const handles = users.map((user) => user.handle).join(", ");

  while (true) {
    const raw = (await deps.prompt(`  Assign to user [${handles}]: `)).trim();
    const selected = raw || users[0]?.handle;

    if (selected && users.some((user) => user.handle === selected)) {
      return selected;
    }

    deps.error(
      `  ✗ User "${selected ?? ""}" not found. Available users: ${handles}`,
    );
  }
}
