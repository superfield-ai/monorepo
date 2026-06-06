import { describe, expect, it } from 'vitest';
import { withScenarioTmpdir } from './tmpdir';
import { buildPinnedEnv } from './env';
import { run } from './proc';

describe('tmpdir', () => {
  it('creates and cleans up a directory', async () => {
    let observedPath = '';
    await withScenarioTmpdir('refactor/ts/example', async (path) => {
      observedPath = path;
      const result = await run('test', ['-d', path], { cwd: '/' });
      expect(result.exitCode).toBe(0);
    });
    const after = await run('test', ['-d', observedPath], { cwd: '/' });
    expect(after.exitCode).not.toBe(0);
  });

  it('keeps the tmpdir on failure when keepOnFailure is set', async () => {
    let kept = '';
    await expect(
      withScenarioTmpdir(
        'refactor/ts/keep_test',
        async (path) => {
          kept = path;
          throw new Error('boom');
        },
        { keepOnFailure: true },
      ),
    ).rejects.toThrow('boom');
    const result = await run('test', ['-d', kept], { cwd: '/' });
    expect(result.exitCode).toBe(0);
    // Cleanup ourselves so we don't leak into /tmp.
    await run('rm', ['-rf', kept], { cwd: '/' });
  });
});

describe('pinned env', () => {
  it('overrides GIT_CONFIG_GLOBAL to /dev/null', () => {
    expect(buildPinnedEnv()).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null' });
  });
  it('does not leak the developer HOME', () => {
    const env = buildPinnedEnv();
    expect(env.HOME).toBe('/tmp');
  });
  it('allows callers to override fields', () => {
    const env = buildPinnedEnv({ HOME: '/somewhere/else' });
    expect(env.HOME).toBe('/somewhere/else');
  });
});

describe('proc.run', () => {
  it('captures stdout, stderr, exit code', async () => {
    const result = await run('sh', ['-c', 'echo out; echo err 1>&2; exit 7'], { cwd: '/tmp' });
    expect(result.exitCode).toBe(7);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });

  it('enforces the timeout', async () => {
    const result = await run('sh', ['-c', 'sleep 5'], { cwd: '/tmp', timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('runs git with no developer config available', async () => {
    // Use `git config --list` to confirm no global/system config bleeds in.
    const result = await run('git', ['config', '--global', '--list'], { cwd: '/tmp' });
    // With GIT_CONFIG_GLOBAL=/dev/null, the global file is empty, so this
    // should succeed with no output or fail cleanly without leaking the
    // developer's identity.
    expect(result.stdout).not.toMatch(/user\.email/);
  });

  it('produces deterministic SHAs given pinned identity and date', async () => {
    // Two consecutive `git commit-tree` invocations with identical inputs
    // must produce identical SHAs. We use the empty tree hash as the
    // tree input (Git's well-known empty-tree SHA).
    const empty = await run('git', ['init', '--quiet', '--bare', '.'], { cwd: '/tmp' });
    expect(empty.exitCode).toBe(0);
    // Use a sub-tmpdir so we don't pollute the parent.
    await withScenarioTmpdir('isolation/det/sha', async (cwd) => {
      const init = await run('git', ['init', '--quiet'], { cwd });
      expect(init.exitCode).toBe(0);
      const empty1 = await run(
        'git',
        ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'msg'],
        { cwd },
      );
      const empty2 = await run(
        'git',
        ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'msg'],
        { cwd },
      );
      expect(empty1.exitCode).toBe(0);
      expect(empty2.exitCode).toBe(0);
      expect(empty1.stdout.trim()).toBe(empty2.stdout.trim());
    });
  });
});
