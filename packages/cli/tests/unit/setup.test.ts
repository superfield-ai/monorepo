import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_GITHUB_APP_CLIENT_ID,
  runLogin,
  runLogout,
  type SetupDeps,
} from '../../commands/setup.ts';
import type { Config } from '@superfield/core';

function makeDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
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
    ...overrides,
  } as SetupDeps;
}

describe('runLogin', () => {
  it('uses GitHub App device flow when client id is configured', async () => {
    const config: Config = { users: [], repositories: [] };
    const deps = makeDeps({
      env: { SUPERFIELD_GITHUB_APP_CLIENT_ID: 'client-123' },
      loadConfig: vi.fn().mockResolvedValue(config),
      requestDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: 'device-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      }),
      pollAccessToken: vi.fn().mockResolvedValue({
        accessToken: 'token-123',
        tokenType: 'bearer',
        scope: 'repo',
      }),
      fetchUserLogin: vi.fn().mockResolvedValue('octocat'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    await runLogin(deps);

    expect(config.users).toEqual([{ handle: 'octocat', token: 'token-123' }]);
    expect(deps.requestDeviceCode).toHaveBeenCalledWith('client-123');
    expect(deps.pollAccessToken).toHaveBeenCalledWith('client-123', 'device-123', 5);
    expect(deps.saveConfig).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('✓ GitHub App already installed');
    expect(deps.log).toHaveBeenCalledWith('  • org/repo');
  });

  it('uses the built-in GitHub App client id when env is absent', async () => {
    const config: Config = { users: [], repositories: [] };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      env: {},
      requestDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: 'device-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      }),
      pollAccessToken: vi.fn().mockResolvedValue({
        accessToken: 'token-123',
        tokenType: 'bearer',
        scope: 'repo',
      }),
      fetchUserLogin: vi.fn().mockResolvedValue('octocat'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    await runLogin(deps);

    expect(config.users).toEqual([{ handle: 'octocat', token: 'token-123' }]);
    expect(deps.requestDeviceCode).toHaveBeenCalledWith(DEFAULT_GITHUB_APP_CLIENT_ID);
    expect(deps.pollAccessToken).toHaveBeenCalledWith(DEFAULT_GITHUB_APP_CLIENT_ID, 'device-123', 5);
    expect(deps.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('prints install URL and polls until app is installed', async () => {
    const config: Config = { users: [], repositories: [] };
    const checkAppInstalled = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(['org/repo1', 'org/repo2']);
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      requestDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: 'device-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      }),
      pollAccessToken: vi.fn().mockResolvedValue({
        accessToken: 'token-123',
        tokenType: 'bearer',
      }),
      fetchUserLogin: vi.fn().mockResolvedValue('octocat'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      checkAppInstalled,
    });

    await runLogin(deps);

    expect(checkAppInstalled).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith(
      '  Open https://github.com/apps/superfield-cli/installations/new',
    );
    expect(deps.log).toHaveBeenCalledWith('✓ App installed');
    expect(deps.log).toHaveBeenCalledWith('  • org/repo1');
    expect(deps.log).toHaveBeenCalledWith('  • org/repo2');
    expect(config.users).toEqual([{ handle: 'octocat', token: 'token-123' }]);
  }, 15_000);

  it('fails when device flow cannot be started', async () => {
    const config: Config = { users: [], repositories: [] };
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      requestDeviceCode: vi.fn().mockRejectedValue(new Error('device flow unavailable')),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    await expect(runLogin(deps)).rejects.toThrow('device flow unavailable');

    expect(config.users).toEqual([]);
    expect(deps.requestDeviceCode).toHaveBeenCalledTimes(1);
    expect(deps.saveConfig).not.toHaveBeenCalled();
  });
});

describe('runLogout', () => {
  it('removes configured GitHub users after confirmation', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghp_123' }],
      repositories: [{ owner: 'my-org', repo: 'my-repo', assignedUser: 'octocat' }],
    };

    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      prompt: vi.fn().mockResolvedValue('y'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    await runLogout(deps);

    expect(config.users).toEqual([]);
    expect(deps.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('removes only the named GitHub user', async () => {
    const config: Config = {
      users: [
        { handle: 'octocat', token: 'ghp_123' },
        { handle: 'alice', token: 'ghp_456' },
      ],
      repositories: [
        { owner: 'my-org', repo: 'my-repo', assignedUser: 'octocat' },
      ],
    };

    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      prompt: vi.fn().mockResolvedValue('y'),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    await runLogout(deps, 'octocat');

    expect(config.users).toEqual([{ handle: 'alice', token: 'ghp_456' }]);
    expect(deps.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('reports when the named GitHub user does not exist', async () => {
    const config: Config = {
      users: [{ handle: 'alice', token: 'ghp_456' }],
      repositories: [],
    };

    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
    });

    await runLogout(deps, 'octocat');

    expect(config.users).toEqual([{ handle: 'alice', token: 'ghp_456' }]);
    expect(deps.saveConfig).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith('No configured GitHub user named "octocat".');
  });
});
