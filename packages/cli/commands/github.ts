import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  loadConfig,
  saveConfig,
  type Config,
  type GitHubUser,
} from "@superfield/core";
import {
  pollGitHubAppAccessToken,
  requestGitHubAppDeviceCode,
} from "@superfield/github";
import { GitHubClient } from "@superfield/github";
import { GitClient } from "@superfield/git";

export const DEFAULT_GITHUB_APP_CLIENT_ID = "Iv23liYrYlh4Sfi9AMaK";
export const DEFAULT_GITHUB_APP_SLUG = "superfield-cli";

export interface GithubDeps {
  loadConfig: () => Promise<Config>;
  saveConfig: (config: Config) => Promise<void>;
  prompt: (question: string) => Promise<string>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  env: NodeJS.ProcessEnv;
  requestDeviceCode: typeof requestGitHubAppDeviceCode;
  pollAccessToken: typeof pollGitHubAppAccessToken;
  fetchUserLogin: (token: string) => Promise<string | null>;
  checkAppInstalled: (
    token: string,
    appSlug: string,
  ) => Promise<string[] | "all" | null>;
  getInstallation: (
    token: string,
    appSlug: string,
  ) => Promise<{
    id: number;
    accountLogin: string;
    accountType: "User" | "Organization";
  } | null>;
  resolveRepo: (repoPath: string) => Promise<{ owner: string; repo: string }>;
}

export async function githubCommand(
  sub?: string,
  repoPath?: string,
): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const deps: GithubDeps = {
      loadConfig,
      saveConfig,
      prompt: (question) => rl.question(question),
      log: console.log,
      error: console.error,
      env: process.env,
      requestDeviceCode: requestGitHubAppDeviceCode,
      pollAccessToken: pollGitHubAppAccessToken,
      fetchUserLogin: async (token) => {
        try {
          const client = new GitHubClient(token);
          const user = await client.getAuthenticatedUser();
          return user.login;
        } catch {
          return null;
        }
      },
      checkAppInstalled: async (_token, _appSlug) => {
        const client = new GitHubClient(_token);
        const installations = await client.listAllInstallations();
        if (installations.length === 0) return null;
        if (installations.some((inst) => inst.repositorySelection === "all"))
          return "all";
        const repoLists = await Promise.all(
          installations.map((inst) => client.listInstallationRepos(inst.id)),
        );
        return repoLists.flat();
      },
      getInstallation: async (token, appSlug) => {
        try {
          const client = new GitHubClient(token);
          const installations = await client.listAppInstallations(appSlug);
          const inst = installations[0];
          if (!inst) return null;
          return {
            id: inst.id,
            accountLogin: inst.accountLogin,
            accountType: inst.accountType,
          };
        } catch {
          return null;
        }
      },
      resolveRepo: async (inputPath) => {
        const gitClient = new GitClient();
        return gitClient.readRemoteOwnerRepo(path.resolve(inputPath));
      },
    };

    if (sub === "add") {
      await runGithubAdd(repoPath, deps);
      return;
    }

    if (sub === "forget") {
      await runGithubForget(deps);
      return;
    }

    console.error("Usage: superfield github add|forget");
    process.exit(1);
  } finally {
    rl.close();
  }
}

export async function runGithubAdd(
  repoPath: string | undefined,
  deps: GithubDeps,
): Promise<void> {
  const config = await deps.loadConfig();
  const clientId =
    deps.env.SUPERFIELD_GITHUB_APP_CLIENT_ID?.trim() ||
    DEFAULT_GITHUB_APP_CLIENT_ID;
  const appSlug =
    deps.env.SUPERFIELD_GITHUB_APP_SLUG?.trim() || DEFAULT_GITHUB_APP_SLUG;

  // Ensure authenticated
  let user: GitHubUser | null = config.users[0] ?? null;
  if (user) {
    const login = await deps.fetchUserLogin(user.token);
    if (login) {
      if (login !== user.handle) {
        user.handle = login;
      }
      deps.log(`✓ Authenticated as @${login}`);
    } else {
      deps.log("Token expired. Re-authenticating...\n");
      user = null;
    }
  }

  if (!user) {
    const result = await runDeviceFlow(clientId, deps);
    user = result.user;
    const existingIndex = config.users.findIndex(
      (u) => u.handle === user!.handle,
    );
    if (existingIndex >= 0) {
      config.users[existingIndex] = user;
    } else {
      config.users.push(user);
    }
  }

  // Resolve target repo
  const resolvedPath = repoPath ? path.resolve(repoPath) : process.cwd();
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await deps.resolveRepo(resolvedPath));
  } catch {
    deps.error(`\n✗ Could not read git remote from ${resolvedPath}`);
    deps.error(
      "  Make sure the path is a git repository with a GitHub origin remote.",
    );
    process.exitCode = 1;
    return;
  }
  const targetRepo = `${owner}/${repo}`;

  // Ensure app is installed and target repo is accessible
  deps.log("");
  let installedRepos = await deps.checkAppInstalled(user.token, appSlug);
  if (installedRepos === null) {
    deps.log(
      `  Open https://github.com/apps/${appSlug}/installations/select_target`,
    );
    deps.log(
      "  Select the repositories you want Superfield to access, then click Install.\n",
    );
    deps.log("Waiting for installation...");
    installedRepos = await pollUntilInstalled(
      user.token,
      appSlug,
      deps,
      targetRepo,
    );
    deps.log("✓ App installed");
    if (installedRepos !== "all") logRepos(installedRepos, deps);
  } else if (
    installedRepos !== "all" &&
    !repoAccessible(installedRepos, targetRepo)
  ) {
    deps.log("✓ GitHub App installed");
    logRepos(installedRepos, deps);
    deps.log(
      `\n  Open https://github.com/apps/${appSlug}/installations/select_target to grant access.`,
    );
    deps.log("");
    deps.log("Waiting for access...");
    installedRepos = await pollUntilRepoAccessible(
      user.token,
      appSlug,
      installedRepos,
      deps,
    );
    logRepos(installedRepos, deps);
  } else {
    deps.log(
      installedRepos === "all"
        ? "✓ GitHub App installed (all repositories)"
        : "✓ GitHub App installed",
    );
    if (installedRepos !== "all") logRepos(installedRepos, deps);
  }

  // Register repo in local config
  const existing = config.repositories.find(
    (r) => r.owner === owner && r.repo === repo,
  );
  if (existing) {
    deps.log(`\n✓ ${targetRepo} already in config`);
  } else {
    config.repositories.push({ owner, repo, assignedUser: user.handle });
    deps.log(`\n✓ Added ${targetRepo} to config`);
  }

  await deps.saveConfig(config);
  deps.log("✓ Config saved to ~/.superfield/config.yaml");
}

export async function runGithubForget(deps: GithubDeps): Promise<void> {
  const config = await deps.loadConfig();
  const appSlug =
    deps.env.SUPERFIELD_GITHUB_APP_SLUG?.trim() || DEFAULT_GITHUB_APP_SLUG;

  if (config.users.length === 0) {
    deps.log("Nothing to forget — no GitHub account configured.");
    return;
  }

  const raw = (
    await deps.prompt(
      "Remove GitHub credentials and repository config? (y/N): ",
    )
  ).trim();
  if (!/^y(es)?$/i.test(raw)) {
    deps.log("Cancelled.");
    return;
  }

  const token = config.users[0]?.token;
  const installation = token
    ? await deps.getInstallation(token, appSlug)
    : null;

  config.users = [];
  config.repositories = [];
  await deps.saveConfig(config);
  deps.log("✓ Config cleared");

  deps.log("\nTo uninstall the app from GitHub, visit:");
  deps.log(`  ${installationManageUrl(installation)}`);
}

async function runDeviceFlow(
  clientId: string,
  deps: GithubDeps,
): Promise<{ user: GitHubUser }> {
  const device = await deps.requestDeviceCode(clientId);
  deps.log(`  Open ${device.verificationUri}`);
  deps.log(`  Enter code: ${device.userCode}\n`);

  const token = await deps.pollAccessToken(
    clientId,
    device.deviceCode,
    device.interval,
  );
  const login = await deps.fetchUserLogin(token.accessToken);
  if (!login) {
    throw new Error(
      "Could not verify GitHub identity after device authorization",
    );
  }

  deps.log(`✓ Authenticated as @${login}`);
  return { user: { handle: login, token: token.accessToken } };
}

async function pollUntilInstalled(
  token: string,
  appSlug: string,
  deps: GithubDeps,
  targetRepo: string,
): Promise<string[] | "all"> {
  const POLL_INTERVAL_MS = 3000;
  const TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    let repos: string[] | "all" | null;
    try {
      repos = await deps.checkAppInstalled(token, appSlug);
    } catch (e) {
      deps.error(`  poll error: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (repos === null) continue;
    if (repos === "all" || repoAccessible(repos, targetRepo)) return repos;
  }

  throw new Error(
    "Timed out waiting for GitHub App installation. " +
      "Run `superfield github add` again after installing the app.",
  );
}

async function pollUntilRepoAccessible(
  token: string,
  appSlug: string,
  previousRepos: string[],
  deps: GithubDeps,
): Promise<string[]> {
  const POLL_INTERVAL_MS = 3000;
  const TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();
  const previousSet = new Set(previousRepos.map((r) => r.toLowerCase()));

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    let repos: string[] | "all" | null;
    try {
      repos = await deps.checkAppInstalled(token, appSlug);
    } catch (e) {
      deps.error(`  poll error: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (repos === "all") return [];
    if (repos !== null && repos.some((r) => !previousSet.has(r.toLowerCase())))
      return repos;
  }

  throw new Error(
    "Timed out waiting for repo access. " +
      "Run `superfield github add` again after granting access.",
  );
}

function installationManageUrl(
  installation: {
    id: number;
    accountLogin: string;
    accountType: "User" | "Organization";
  } | null,
): string {
  if (!installation) return "https://github.com/settings/installations";
  if (installation.accountType === "Organization") {
    return `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.id}`;
  }
  return `https://github.com/settings/installations/${installation.id}`;
}

function repoAccessible(repos: string[], targetRepo: string): boolean {
  const target = targetRepo.toLowerCase();
  return repos.some((r) => r.toLowerCase() === target);
}

function logRepos(repos: string[], deps: GithubDeps): void {
  if (repos.length === 0) {
    deps.log("  (no repositories selected)");
    return;
  }
  for (const repo of repos) {
    deps.log(`  • ${repo}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
