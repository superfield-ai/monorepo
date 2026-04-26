/**
 * @file packages/core/tests/worktree-manager.test.ts
 *
 * Unit tests for worktree-manager module — git worktree create/delete
 * functions produce correct git commands and branch names.
 *
 * Issue #28 test plan items:
 *   - Unit: worktree create/delete functions produce correct git commands
 *     and branch names
 *
 * @see packages/core/worktree-manager.ts
 * @see docs/studio-sessions.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));

vi.mock('../spawn', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

import { existsSync } from 'fs';

describe('worktree-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveWorktreeBaseDir', () => {
    it('uses override when provided', async () => {
      const { resolveWorktreeBaseDir } = await import('../worktree-manager');
      const result = resolveWorktreeBaseDir('/product', '/custom/base');
      expect(result).toBe('/custom/base');
    });

    it('defaults to sibling studio-worktrees directory', async () => {
      const { resolveWorktreeBaseDir } = await import('../worktree-manager');
      const result = resolveWorktreeBaseDir('/home/user/product');
      expect(result).toContain('studio-worktrees');
    });
  });

  describe('getMainHash', () => {
    it('returns trimmed stdout from git rev-parse HEAD', async () => {
      spawnMock.mockReturnValue({
        status: 0,
        stdout: 'abc123def456\n',
        stderr: '',
      });

      const { getMainHash } = await import('../worktree-manager');
      const hash = getMainHash('/product');

      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: '/product' },
      );
      expect(hash).toBe('abc123def456');
    });

    it('throws on git failure', async () => {
      spawnMock.mockReturnValue({
        status: 128,
        stdout: '',
        stderr: 'fatal: not a git repo',
      });

      const { getMainHash } = await import('../worktree-manager');
      expect(() => getMainHash('/not-a-repo')).toThrow('Failed to get main HEAD');
    });
  });

  describe('createWorktree', () => {
    it('creates worktree with correct branch name and path', async () => {
      spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

      const { createWorktree } = await import('../worktree-manager');
      const result = createWorktree({
        sourceDir: '/product',
        mainHash: 'abc123',
        sessionId: 'x1y2',
        worktreeBaseDir: '/tmp/wt',
      });

      expect(result.sessionId).toBe('x1y2');
      expect(result.branch).toBe('studio/session-abc123-x1y2');
      expect(result.worktreePath).toBe('/tmp/wt/studio-session-abc123-x1y2');

      // Verify the git command.
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        [
          'worktree', 'add', '-b',
          'studio/session-abc123-x1y2',
          '/tmp/wt/studio-session-abc123-x1y2',
          'abc123',
        ],
        { cwd: '/product' },
      );
    });

    it('generates session ID when not provided', async () => {
      spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

      const { createWorktree } = await import('../worktree-manager');
      const result = createWorktree({
        sourceDir: '/product',
        mainHash: 'def456',
        worktreeBaseDir: '/tmp/wt',
      });

      // Session ID should be 4 characters.
      expect(result.sessionId).toMatch(/^[a-z0-9]{4}$/);
      expect(result.branch).toBe(`studio/session-def456-${result.sessionId}`);
    });

    it('throws on git worktree add failure', async () => {
      spawnMock.mockReturnValue({
        status: 128,
        stdout: '',
        stderr: 'fatal: branch already exists',
      });

      const { createWorktree } = await import('../worktree-manager');
      expect(() =>
        createWorktree({
          sourceDir: '/product',
          mainHash: 'abc123',
          sessionId: 'x1y2',
          worktreeBaseDir: '/tmp/wt',
        }),
      ).toThrow('Failed to create worktree');
    });
  });

  describe('deleteWorktree', () => {
    it('removes worktree and deletes branch', async () => {
      spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

      const { deleteWorktree } = await import('../worktree-manager');
      deleteWorktree({
        sourceDir: '/product',
        worktreePath: '/tmp/wt/studio-session-abc123-x1y2',
        branch: 'studio/session-abc123-x1y2',
      });

      // First call: worktree remove.
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['worktree', 'remove', '--force', '/tmp/wt/studio-session-abc123-x1y2'],
        { cwd: '/product' },
      );

      // Second call: branch delete.
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['branch', '-D', 'studio/session-abc123-x1y2'],
        { cwd: '/product' },
      );
    });

    it('throws if worktree remove fails', async () => {
      spawnMock.mockReturnValue({
        status: 128,
        stdout: '',
        stderr: 'fatal: not a valid worktree',
      });

      const { deleteWorktree } = await import('../worktree-manager');
      expect(() =>
        deleteWorktree({
          sourceDir: '/product',
          worktreePath: '/tmp/wt/does-not-exist',
          branch: 'studio/session-abc123-x1y2',
        }),
      ).toThrow('Failed to remove worktree');
    });

    it('tolerates branch deletion failure', async () => {
      spawnMock
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // worktree remove
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'branch not found' }); // branch -D

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { deleteWorktree } = await import('../worktree-manager');
      // Should not throw.
      deleteWorktree({
        sourceDir: '/product',
        worktreePath: '/tmp/wt/studio-session-abc123-x1y2',
        branch: 'studio/session-abc123-x1y2',
      });

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('listWorktrees', () => {
    it('parses porcelain output into entries', async () => {
      spawnMock.mockReturnValue({
        status: 0,
        stdout: [
          'worktree /product',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
          'worktree /tmp/wt/studio-session-abc123-x1y2',
          'HEAD def456',
          'branch refs/heads/studio/session-abc123-x1y2',
          '',
        ].join('\n'),
        stderr: '',
      });

      const { listWorktrees } = await import('../worktree-manager');
      const entries = listWorktrees('/product');

      expect(entries).toEqual([
        { path: '/product', branch: 'main' },
        { path: '/tmp/wt/studio-session-abc123-x1y2', branch: 'studio/session-abc123-x1y2' },
      ]);
    });

    it('returns empty array on git failure', async () => {
      spawnMock.mockReturnValue({ status: 128, stdout: '', stderr: 'error' });

      const { listWorktrees } = await import('../worktree-manager');
      expect(listWorktrees('/product')).toEqual([]);
    });
  });

  describe('worktreeExists', () => {
    it('returns true when directory exists', async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const { worktreeExists } = await import('../worktree-manager');
      expect(worktreeExists('/tmp/wt/some-worktree')).toBe(true);
    });

    it('returns false when directory does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { worktreeExists } = await import('../worktree-manager');
      expect(worktreeExists('/tmp/wt/gone')).toBe(false);
    });
  });
});
