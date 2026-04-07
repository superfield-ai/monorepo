import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_GITHUB_APP_CLIENT_ID, runGithubAdd, runGithubForget, type GithubDeps } from '../../commands/github.ts';
import type { Config } from '@superfield/core';

function makeDeps(overrides: Partial<GithubDeps> = {}): GithubDeps {
  return {
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    prompt: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    env: {},
    requestDeviceCode: vi.fn(),
    pollAccessToken: vi.fn(),
    fetchUserLogin: vi.fn(),
    checkAppInstalled: vi.fn().mockResolvedValue(['org/repo']),
    getInstallation: vi.fn().mockResolvedValue({ id: 12345678, accountLogin: "octocat", accountType: "User" }),
    resolveRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'repo' }),
    ...overrides,
  } as GithubDeps;
}

describe('runGithubAdd', () => {
  it('skips device flow when existing token is valid and repo is accessible', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghu_existing' }],
      repositories: [],
    };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      fetchUserLogin: vi.fn().mockResolvedValue('octocat'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      resolveRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'repo' }),
      checkAppInstalled: vi.fn().mockResolvedValue(['org/repo']),
    });

    await runGithubAdd(undefined, deps);

    expect(deps.requestDeviceCode).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('✓ Authenticated as @octocat');
    expect(config.repositories).toEqual([{ owner: 'org', repo: 'repo', assignedUser: 'octocat' }]);
  });

  it('prompts user to grant access when app is installed but target repo is missing', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghu_existing' }],
      repositories: [],
    };
    const checkAppInstalled = vi.fn()
      .mockResolvedValueOnce(['org/other-repo'])           // initial check: installed, wrong repo
      .mockResolvedValueOnce(['org/other-repo'])           // poll 1: still missing
      .mockResolvedValueOnce(['org/other-repo', 'org/new-repo']); // poll 2: accessible
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      fetchUserLogin: vi.fn().mockResolvedValue('octocat'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      resolveRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'new-repo' }),
      getInstallation: vi.fn().mockResolvedValue({ id: 12345678, accountLogin: "octocat", accountType: "User" }),
      checkAppInstalled,
    });

    await runGithubAdd(undefined, deps);

    expect(deps.log).toHaveBeenCalledWith(
      '\n  Open https://github.com/apps/superfield-cli/installations/select_target to grant access.',
    );
    expect(deps.log).toHaveBeenCalledWith('Waiting for access...');
    expect(config.repositories).toEqual([{ owner: 'org', repo: 'new-repo', assignedUser: 'octocat' }]);
  }, 15_000);

  it('runs device flow when no user is configured', async () => {
    const config: Config = { users: [], repositories: [] };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      env: { SUPERFIELD_GITHUB_APP_CLIENT_ID: 'client-123' },
      requestDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: 'device-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      }),
      pollAccessToken: vi.fn().mockResolvedValue({ accessToken: 'ghu_new', tokenType: 'bearer' }),
      fetchUserLogin: vi.fn().mockResolvedValue('octocat'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      resolveRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'repo' }),
    });

    await runGithubAdd(undefined, deps);

    expect(deps.requestDeviceCode).toHaveBeenCalledWith('client-123');
    expect(config.users).toEqual([{ handle: 'octocat', token: 'ghu_new' }]);
    expect(config.repositories).toEqual([{ owner: 'org', repo: 'repo', assignedUser: 'octocat' }]);
  });

  it('runs device flow when existing token is expired', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghu_expired' }],
      repositories: [],
    };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      fetchUserLogin: vi.fn()
        .mockResolvedValueOnce(null)       // expired check
        .mockResolvedValueOnce('octocat'), // after device flow
      requestDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: 'device-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      }),
      pollAccessToken: vi.fn().mockResolvedValue({ accessToken: 'ghu_fresh', tokenType: 'bearer' }),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      resolveRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'repo' }),
    });

    await runGithubAdd(undefined, deps);

    expect(deps.log).toHaveBeenCalledWith('Token expired. Re-authenticating...\n');
    expect(deps.requestDeviceCode).toHaveBeenCalledWith(DEFAULT_GITHUB_APP_CLIENT_ID);
    expect(config.users[0]?.token).toBe('ghu_fresh');
  });

  it('skips adding repo when already in config', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghu_existing' }],
      repositories: [{ owner: 'org', repo: 'repo', assignedUser: 'octocat' }],
    };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      fetchUserLogin: vi.fn().mockResolvedValue('octocat'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      resolveRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'repo' }),
    });

    await runGithubAdd(undefined, deps);

    expect(config.repositories).toHaveLength(1);
    expect(deps.log).toHaveBeenCalledWith('\n✓ org/repo already in config');
  });

  it('polls until app installation appears', async () => {
    const config: Config = { users: [], repositories: [] };
    const checkAppInstalled = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(['org/repo']);
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      requestDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: 'device-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      }),
      pollAccessToken: vi.fn().mockResolvedValue({ accessToken: 'ghu_new', tokenType: 'bearer' }),
      fetchUserLogin: vi.fn().mockResolvedValue('octocat'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      resolveRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'repo' }),
      checkAppInstalled,
    });

    await runGithubAdd(undefined, deps);

    expect(checkAppInstalled).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith('✓ App installed');
  }, 15_000);
});

describe('runGithubForget', () => {
  it('clears config and prints installation-specific uninstall URL', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghu_existing' }],
      repositories: [{ owner: 'org', repo: 'repo', assignedUser: 'octocat' }],
    };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      prompt: vi.fn().mockResolvedValue('y'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      getInstallation: vi.fn().mockResolvedValue({ id: 12345678, accountLogin: "octocat", accountType: "User" }),
    });

    await runGithubForget(deps);

    expect(config.users).toEqual([]);
    expect(config.repositories).toEqual([]);
    expect(deps.saveConfig).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('  https://github.com/settings/installations/12345678');
  });

  it('prints generic uninstall URL when installation id cannot be fetched', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghu_existing' }],
      repositories: [],
    };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      prompt: vi.fn().mockResolvedValue('y'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      getInstallation: vi.fn().mockResolvedValue(null),
    });

    await runGithubForget(deps);

    expect(deps.log).toHaveBeenCalledWith('  https://github.com/settings/installations');
  });

  it('does nothing when no account is configured', async () => {
    const config: Config = { users: [], repositories: [] };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    await runGithubForget(deps);

    expect(deps.saveConfig).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('Nothing to forget — no GitHub account configured.');
  });

  it('cancels when user does not confirm', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghu_existing' }],
      repositories: [],
    };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      prompt: vi.fn().mockResolvedValue('n'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    await runGithubForget(deps);

    expect(deps.saveConfig).not.toHaveBeenCalled();
    expect(config.users).toHaveLength(1);
  });
});
