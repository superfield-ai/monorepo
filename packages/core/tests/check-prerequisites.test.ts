/**
 * @file packages/core/tests/check-prerequisites.test.ts
 *
 * Unit tests for checkPrerequisites() — verifies k3d and other required
 * tools are checked on PATH and that missing tools cause a fast-fail with
 * a clear error message.
 *
 * Issue #67: studio must require k3d (not k3s) and fail fast with a
 * 'Missing: k3d' error when k3d is absent from PATH.
 *
 * @see packages/core/verify-cluster.ts — checkPrerequisites()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process.spawnSync to simulate tool presence/absence.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
  };
});

describe('checkPrerequisites', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds when docker, kubectl, and k3d are all present', async () => {
    const { spawnSync: spawnSyncMock } = await import('child_process');
    vi.mocked(spawnSyncMock).mockReturnValue({
      status: 0, stdout: Buffer.from('/usr/bin/tool'), stderr: Buffer.from(''),
      pid: 1, output: [], signal: null,
    });

    const { checkPrerequisites } = await import('../verify-cluster');
    checkPrerequisites();

    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('exits with error when k3d is missing from PATH', async () => {
    const { spawnSync: spawnSyncMock } = await import('child_process');
    // docker → found, kubectl → found, k3d → not found
    vi.mocked(spawnSyncMock).mockImplementation(((_cmd: string, args: string[]) => {
      const tool = (args as string[])[0];
      if (tool === 'k3d') {
        return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('not found'), pid: 1, output: [], signal: null };
      }
      return { status: 0, stdout: Buffer.from('/usr/bin/' + tool), stderr: Buffer.from(''), pid: 1, output: [], signal: null };
    }) as typeof import('child_process').spawnSync);

    const { checkPrerequisites } = await import('../verify-cluster');
    checkPrerequisites();

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing required tools'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('k3d'));
  });

  it('prints k3d installation URL when k3d is missing', async () => {
    const { spawnSync: spawnSyncMock } = await import('child_process');
    vi.mocked(spawnSyncMock).mockImplementation(((_cmd: string, args: string[]) => {
      const tool = (args as string[])[0];
      if (tool === 'k3d') {
        return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from(''), pid: 1, output: [], signal: null };
      }
      return { status: 0, stdout: Buffer.from('/usr/bin/' + tool), stderr: Buffer.from(''), pid: 1, output: [], signal: null };
    }) as typeof import('child_process').spawnSync);

    const { checkPrerequisites } = await import('../verify-cluster');
    checkPrerequisites();

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('k3d.io'));
  });

  it('requires k3d specifically (not k3s)', async () => {
    const { spawnSync: spawnSyncMock } = await import('child_process');
    // Capture all 'which' calls to verify k3d is checked, k3s is not
    const toolsChecked: string[] = [];
    vi.mocked(spawnSyncMock).mockImplementation(((_cmd: string, args: string[]) => {
      toolsChecked.push((args as string[])[0]);
      return { status: 0, stdout: Buffer.from('/usr/bin/tool'), stderr: Buffer.from(''), pid: 1, output: [], signal: null };
    }) as typeof import('child_process').spawnSync);

    const { checkPrerequisites } = await import('../verify-cluster');
    checkPrerequisites();

    expect(toolsChecked).toContain('k3d');
    expect(toolsChecked).not.toContain('k3s');
  });
});
