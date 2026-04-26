/**
 * Unit tests for studio/apps/server/src/process-manager.ts
 *
 * Issue #164 test plan items covered:
 *   - Unit test: shutdown sequence sends SIGTERM then SIGKILL after timeout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessManager, SIGKILL_TIMEOUT_MS } from '../../src/process-manager';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a fake Bun subprocess handle.
 *
 * @param exitDelayMs If provided, the process "exits" after this many ms.
 *                    If undefined, the process never exits on its own.
 */
function makeFakeProc(exitDelayMs?: number): {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  exited: Promise<number>;
} {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((res) => {
    resolveExited = res;
  });

  let exitCode: number | null = null;

  const kill = vi.fn((signal?: string) => {
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      // Simulate the process dying when explicitly killed.
      exitCode = signal === 'SIGTERM' ? 0 : 137;
      resolveExited(exitCode);
    }
  });

  if (exitDelayMs !== undefined) {
    setTimeout(() => {
      exitCode = 0;
      resolveExited(0);
    }, exitDelayMs);
  }

  return {
    get exitCode() {
      return exitCode;
    },
    kill,
    exited,
  };
}

// ── ProcessManager ────────────────────────────────────────────────────────────

describe('ProcessManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts with zero children', () => {
    const pm = new ProcessManager();
    expect(pm.count).toBe(0);
  });

  it('registers a process via register()', () => {
    const pm = new ProcessManager();
    const proc = makeFakeProc(0);
    pm.register(proc as unknown as ReturnType<typeof Bun.spawn>, 'test-proc');
    expect(pm.count).toBe(1);
  });

  it('sends SIGTERM to registered processes on shutdown', async () => {
    const pm = new ProcessManager();
    const proc = makeFakeProc(); // exits only when killed
    pm.register(proc as unknown as ReturnType<typeof Bun.spawn>, 'test-proc');

    const shutdownPromise = pm.shutdown();
    // Allow the SIGTERM to be sent before advancing timers.
    await Promise.resolve();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // The process exits in response to SIGTERM — no need to advance timers.
    await shutdownPromise;
  });

  it('clears the children list after shutdown', async () => {
    const pm = new ProcessManager();
    const proc = makeFakeProc();
    pm.register(proc as unknown as ReturnType<typeof Bun.spawn>, 'proc-a');

    const shutdownPromise = pm.shutdown();
    await Promise.resolve();
    await shutdownPromise;

    expect(pm.count).toBe(0);
  });

  it('sends SIGKILL when a process does not exit within the timeout', async () => {
    const pm = new ProcessManager();
    // This process ignores SIGTERM — only exits on SIGKILL.
    let sigkillResolver!: () => void;
    const exited = new Promise<number>((res) => {
      sigkillResolver = () => res(137);
    });
    let exitCode: number | null = null;
    const kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        exitCode = 137;
        sigkillResolver();
      }
      // SIGTERM is deliberately ignored.
    });
    const stubbornProc = {
      get exitCode() {
        return exitCode;
      },
      kill,
      exited,
    };

    pm.register(stubbornProc as unknown as ReturnType<typeof Bun.spawn>, 'stubborn');

    const shutdownPromise = pm.shutdown();

    // SIGTERM should be sent immediately.
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith('SIGTERM');

    // Advance time past the SIGKILL timeout.
    await vi.advanceTimersByTimeAsync(SIGKILL_TIMEOUT_MS + 100);

    await shutdownPromise;

    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('skips already-exited processes during shutdown', async () => {
    const pm = new ProcessManager();
    // Simulate a process that has already exited (exitCode is not null).
    const proc = {
      exitCode: 0,
      kill: vi.fn(),
      exited: Promise.resolve(0),
    };
    pm.register(proc as unknown as ReturnType<typeof Bun.spawn>, 'already-done');

    await pm.shutdown();

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('handles multiple processes concurrently', async () => {
    const pm = new ProcessManager();

    const proc1 = makeFakeProc(); // exits on SIGTERM
    const proc2 = makeFakeProc(); // exits on SIGTERM

    pm.register(proc1 as unknown as ReturnType<typeof Bun.spawn>, 'p1');
    pm.register(proc2 as unknown as ReturnType<typeof Bun.spawn>, 'p2');

    expect(pm.count).toBe(2);

    const shutdownPromise = pm.shutdown();
    await Promise.resolve();

    expect(proc1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc2.kill).toHaveBeenCalledWith('SIGTERM');

    await shutdownPromise;
    expect(pm.count).toBe(0);
  });
});
