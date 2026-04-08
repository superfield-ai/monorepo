/**
 * Unit tests for packages/cli/commands/start.ts
 *
 * Issue #1: wire all three loops (planning, dev, doc) into startCommand.
 * Verifies that all three loops are started concurrently and each receives
 * correct owner/repo/repoPath args.
 */
import { describe, it, expect, vi } from 'vitest';
import { startCommand, type StartDeps } from '../../commands/start.ts';

function makeDeps(overrides: Partial<StartDeps> = {}): StartDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      users: [{ handle: 'alice', token: 'ghp_tok' }],
      repositories: [{ owner: 'org', repo: 'myrepo', assignedUser: 'alice' }],
    }),
    resolveRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'myrepo' }),
    runPlanningLoop: vi.fn().mockResolvedValue(undefined),
    runDevLoop: vi.fn().mockResolvedValue(undefined),
    runDocLoop: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as StartDeps['exit'],
    ...overrides,
  };
}

describe('startCommand', () => {
  it('starts all three loops when called with a valid repo path', async () => {
    const deps = makeDeps();
    await startCommand('/home/user/project', deps);

    expect(deps.runPlanningLoop).toHaveBeenCalledOnce();
    expect(deps.runDevLoop).toHaveBeenCalledOnce();
    expect(deps.runDocLoop).toHaveBeenCalledOnce();
  });

  it('passes owner and repo to all three loops', async () => {
    const deps = makeDeps();
    await startCommand('/home/user/project', deps);

    const planArg = (deps.runPlanningLoop as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(planArg).toMatchObject({
      repositories: [expect.objectContaining({ owner: 'org', repo: 'myrepo' })],
    });

    const devArg = (deps.runDevLoop as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(devArg).toMatchObject({ owner: 'org', repo: 'myrepo' });

    const docArg = (deps.runDocLoop as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(docArg).toMatchObject({ owner: 'org', repo: 'myrepo' });
  });

  it('passes the repoPath to the doc loop', async () => {
    const deps = makeDeps();
    await startCommand('/home/user/project', deps);

    const docArg = (deps.runDocLoop as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(docArg.repoPath).toBe('/home/user/project');
  });

  it('exits with error when no repoPath is given', async () => {
    const exit = vi.fn() as unknown as StartDeps['exit'];
    const deps = makeDeps({ exit });
    await startCommand(undefined, deps);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits with error when no users are configured', async () => {
    const exit = vi.fn() as unknown as StartDeps['exit'];
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue({ users: [], repositories: [] }),
      exit,
    });
    await startCommand('/home/user/project', deps);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
