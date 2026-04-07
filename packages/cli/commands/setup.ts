import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig, type Config, type GitHubUser } from '@superfield/core';
import {
  pollGitHubAppAccessToken,
  requestGitHubAppDeviceCode,
} from '@superfield/github';
import { GitHubClient } from '@superfield/github';

export const DEFAULT_GITHUB_APP_CLIENT_ID = 'Iv23liYrYlh4Sfi9AMaK';
export const DEFAULT_GITHUB_APP_SLUG = 'superfield-cli';

export interface SetupDeps {
  loadConfig: () => Promise<Config>;
  saveConfig: (config: Config) => Promise<void>;
  prompt: (question: string) => Promise<string>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  env: NodeJS.ProcessEnv;
  requestDeviceCode: typeof requestGitHubAppDeviceCode;
  pollAccessToken: typeof pollGitHubAppAccessToken;
  fetchUserLogin: (token: string) => Promise<string | null>;
  checkAppInstalled: (token: string, appSlug: string) => Promise<string[] | 'all' | null>;
}

export async function setupCommand(action?: string, handle?: string): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const deps: SetupDeps = {
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
      checkAppInstalled: async (token, appSlug) => {
        try {
          const client = new GitHubClient(token);
          const installations = await client.listAppInstallations(appSlug);
          if (installations.length === 0) return null;
          const repoLists = await Promise.all(
            installations.map((inst) => client.listInstallationRepos(inst.id)),
          );
          return repoLists.flat();
        } catch {
          return null;
        }
      },
    };

    if (action === 'gh-logout') {
      await runLogout(deps, handle);
      return;
    }

    if (action === 'gh-login' || action === undefined) {
      await runLogin(deps);
      return;
    }

    console.error('Usage: superfield setup gh-login|gh-logout');
    process.exit(1);
  } finally {
    rl.close();
  }
}

export async function runLogin(deps: SetupDeps): Promise<void> {
  const config = await deps.loadConfig();
  const clientId = deps.env.SUPERFIELD_GITHUB_APP_CLIENT_ID?.trim() || DEFAULT_GITHUB_APP_CLIENT_ID;
  const appSlug = deps.env.SUPERFIELD_GITHUB_APP_SLUG?.trim() || DEFAULT_GITHUB_APP_SLUG;

  deps.log('Step 1/2 — Authorize\n');
  const result = await runDeviceFlow(clientId, deps);

  deps.log('\nStep 2/2 — Install app\n');
  const existingRepos = await deps.checkAppInstalled(result.user.token, appSlug);
  if (existingRepos !== null) {
    deps.log('✓ GitHub App already installed');
    logRepos(existingRepos, deps);
  } else {
    deps.log(`  Open https://github.com/apps/${appSlug}/installations/new`);
    deps.log('  Select the repositories you want Superfield to access, then click Install.\n');
    deps.log('Waiting for installation...');
    const repos = await pollUntilInstalled(result.user.token, appSlug, deps);
    deps.log('✓ App installed');
    logRepos(repos, deps);
  }

  upsertUser(config, result.user);
  await deps.saveConfig(config);
  deps.log('\n✓ Setup complete. Config saved to ~/.superfield/config.yaml');
}

export async function runLogout(deps: SetupDeps, handle?: string): Promise<void> {
  const config = await deps.loadConfig();

  deps.log('superfield setup gh-logout\n');

  if (config.users.length === 0) {
    deps.log('No GitHub users are configured.');
    return;
  }

  const targetHandle = handle?.trim();

  if (targetHandle) {
    const existing = config.users.find((user) => user.handle === targetHandle);
    if (!existing) {
      deps.error(`No configured GitHub user named "${targetHandle}".`);
      return;
    }

    const raw = (await deps.prompt(`Remove GitHub user "${targetHandle}"? (y/N): `)).trim();
    if (!/^y(es)?$/i.test(raw)) {
      deps.log('Cancelled.');
      return;
    }

    config.users = config.users.filter((user) => user.handle !== targetHandle);
    await deps.saveConfig(config);
    deps.log(`✓ Removed GitHub user "${targetHandle}".`);
    if (config.repositories.some((repo) => repo.assignedUser === targetHandle)) {
      deps.error(
        `Note: repository assignments still reference "${targetHandle}". Re-authorize GitHub access or update configuration to reassign them.`,
      );
    }
    return;
  }

  const summary = config.users.map((user) => user.handle).join(', ');
  const raw = (await deps.prompt(`Remove configured GitHub users [${summary}]? (y/N): `)).trim();

  if (!/^y(es)?$/i.test(raw)) {
    deps.log('Cancelled.');
    return;
  }

  config.users = [];
  await deps.saveConfig(config);
  deps.log('✓ Removed configured GitHub users.');
  if (config.repositories.length > 0) {
    deps.error(
      'Note: repository assignments still reference removed handles. Re-authorize GitHub access or update configuration to reassign them.',
    );
  }
}

async function runDeviceFlow(clientId: string, deps: SetupDeps): Promise<{ user: GitHubUser }> {
  const device = await deps.requestDeviceCode(clientId);
  deps.log(`  Open ${device.verificationUri}`);
  deps.log(`  Enter code: ${device.userCode}\n`);

  const token = await deps.pollAccessToken(clientId, device.deviceCode, device.interval);
  const login = await deps.fetchUserLogin(token.accessToken);
  if (!login) {
    throw new Error('Could not verify GitHub identity after device authorization');
  }

  deps.log(`✓ Authenticated as @${login}`);
  return { user: { handle: login, token: token.accessToken } };
}

async function pollUntilInstalled(token: string, appSlug: string, deps: SetupDeps): Promise<string[]> {
  const POLL_INTERVAL_MS = 3000;
  const TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const repos = await deps.checkAppInstalled(token, appSlug);
    if (repos !== null) {
      return repos;
    }
  }

  throw new Error(
    'Timed out waiting for GitHub App installation. ' +
      'Run `superfield setup gh-login` again after installing the app.',
  );
}

function logRepos(repos: string[], deps: SetupDeps): void {
  if (repos.length === 0) {
    deps.log('  (no repositories selected)');
    return;
  }
  for (const repo of repos) {
    deps.log(`  • ${repo}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upsertUser(config: Config, user: GitHubUser): void {
  const existing = config.users.findIndex((item) => item.handle === user.handle);
  if (existing >= 0) {
    config.users[existing] = user;
    return;
  }

  config.users.push(user);
}
