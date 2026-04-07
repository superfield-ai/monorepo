import { describe, it, expect, vi } from 'vitest';
import { runDoctor, type DoctorDeps } from '../../commands/doctor.ts';
import type { Config } from '@superfield/core';

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    prompt: vi.fn(),
    resolveRepo: vi.fn(),
    authenticateToken: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  } as DoctorDeps;
}

describe('runDoctor', () => {
  it('adds the current repository when it is missing from config', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghp_valid' }],
      repositories: [],
    };

    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      resolveRepo: vi.fn().mockResolvedValue({ owner: 'my-org', repo: 'my-repo' }),
      authenticateToken: vi.fn().mockResolvedValue('octocat'),
      prompt: vi.fn().mockResolvedValue(''),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    const report = await runDoctor('/tmp/my-repo', deps);

    expect(report).toEqual({ dirty: true, unresolved: false });
    expect(deps.saveConfig).toHaveBeenCalledTimes(1);
    expect(config.repositories).toEqual([
      { owner: 'my-org', repo: 'my-repo', assignedUser: 'octocat' },
    ]);
  });

  it('renames a configured user when the token authenticates as a different login', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghp_old' }],
      repositories: [],
    };

    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      authenticateToken: vi.fn().mockImplementation(async (token: string) => {
        if (token === 'ghp_old') return 'alice';
        return null;
      }),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    const report = await runDoctor(undefined, deps);

    expect(report).toEqual({ dirty: true, unresolved: false });
    expect(config.users).toEqual([{ handle: 'alice', token: 'ghp_old' }]);
    expect(deps.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('marks invalid auth as unresolved and points users back to gh-login', async () => {
    const config: Config = {
      users: [{ handle: 'octocat', token: 'ghp_old' }],
      repositories: [],
    };

    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue(config),
      authenticateToken: vi.fn().mockResolvedValue(null),
      saveConfig: vi.fn().mockResolvedValue(undefined),
    });

    const report = await runDoctor(undefined, deps);

    expect(report).toEqual({ dirty: false, unresolved: true });
    expect(config.users).toEqual([{ handle: 'octocat', token: 'ghp_old' }]);
    expect(deps.saveConfig).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      '  Run `superfield github add` to refresh the GitHub App authorization.',
    );
  });
});
