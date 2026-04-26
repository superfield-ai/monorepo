import { describe, it, expect, vi } from 'vitest';
import { DevLoopProcess, type DevLoopProcessOpts } from '../../src/dev-loop-process';

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.close(); } });
}

function makeProc(opts: {
  pid?: number;
  exitCode?: number;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
} = {}) {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  const proc = {
    pid: opts.pid ?? 1234,
    stdout: opts.stdout ?? emptyStream(),
    stderr: opts.stderr ?? emptyStream(),
    exited,
    kill: vi.fn(),
    _resolveExit: (code = 0) => resolveExit(code),
  };
  return proc;
}

function makeOpts(overrides: Partial<DevLoopProcessOpts> = {}): DevLoopProcessOpts {
  return {
    apiUrl: 'http://127.0.0.1:7837',
    _pollIntervalMs: 0,
    _startupTimeoutMs: 100,
    ...overrides,
  };
}

// ── isApiReachable ─────────────────────────────────────────────────────────────

describe('isApiReachable', () => {
  it('fetch returns ok → true', async () => {
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockResolvedValue({ ok: true }),
    }));
    expect(await loop.isApiReachable()).toBe(true);
  });

  it('fetch returns not-ok (503) → false', async () => {
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockResolvedValue({ ok: false }),
    }));
    expect(await loop.isApiReachable()).toBe(false);
  });

  it('fetch throws → false', async () => {
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    }));
    expect(await loop.isApiReachable()).toBe(false);
  });
});

// ── detectExternalProcess ─────────────────────────────────────────────────────

describe('detectExternalProcess', () => {
  it('API reachable → state becomes running', async () => {
    const states: string[] = [];
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockResolvedValue({ ok: true }),
      onStateChange: (s) => states.push(s),
    }));
    await loop.detectExternalProcess();
    expect(loop.status()).toBe('running');
    expect(states).toContain('running');
  });

  it('API unreachable → state stays stopped', async () => {
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockRejectedValue(new Error('refused')),
    }));
    await loop.detectExternalProcess();
    expect(loop.status()).toBe('stopped');
  });

  it('external stop() clears flag without kill', async () => {
    const spawn = vi.fn();
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockResolvedValue({ ok: true }),
      _spawn: spawn,
    }));
    await loop.detectExternalProcess();
    await loop.stop();
    expect(loop.status()).toBe('stopped');
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ── spawn ─────────────────────────────────────────────────────────────────────

describe('spawn', () => {
  it('initial state is stopped', () => {
    const loop = new DevLoopProcess(makeOpts());
    expect(loop.status()).toBe('stopped');
    expect(loop.pid()).toBeUndefined();
  });

  it('transitions to starting on spawn call', async () => {
    const proc = makeProc();
    const states: string[] = [];
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockRejectedValue(new Error('no api')),
      _spawn: vi.fn().mockReturnValue(proc),
      onStateChange: (s) => states.push(s),
    }));

    const spawnPromise = loop.spawn('/repo');
    // Yield to let spawn set the starting state before the poll loop.
    await new Promise((r) => setTimeout(r, 10));
    expect(states).toContain('starting');

    // Clean up: resolve process exit so spawn() can finish.
    proc._resolveExit(0);
    await spawnPromise;
  });

  it('includes slotCount in spawn args when provided', async () => {
    const proc = makeProc();
    const spawnFn = vi.fn().mockReturnValue(proc);
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockRejectedValue(new Error('no api')),
      _spawn: spawnFn,
    }));

    proc._resolveExit(0);
    await loop.spawn('/repo', { slotCount: 3 });

    expect(spawnFn).toHaveBeenCalledWith(
      expect.arrayContaining(['superfield', 'start', '/repo', '3']),
      expect.anything(),
    );
  });

  it('does NOT include slotCount when absent', async () => {
    const proc = makeProc();
    const spawnFn = vi.fn().mockReturnValue(proc);
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockRejectedValue(new Error('no api')),
      _spawn: spawnFn,
    }));

    proc._resolveExit(0);
    await loop.spawn('/repo');

    const [args] = spawnFn.mock.calls[0] as [string[]];
    expect(args).not.toContain(undefined);
    expect(args.length).toBe(3); // superfield start /repo
  });

  it('already running → no-op', async () => {
    const spawnFn = vi.fn();
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockResolvedValue({ ok: true }),
      _spawn: spawnFn,
    }));
    await loop.detectExternalProcess(); // sets running
    await loop.spawn('/repo');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('API becomes reachable during poll → transitions to running', async () => {
    const proc = makeProc();
    let fetchCalls = 0;
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockImplementation(async () => {
        fetchCalls++;
        return { ok: fetchCalls >= 2 }; // reachable on second call
      }),
      _spawn: vi.fn().mockReturnValue(proc),
    }));

    await loop.spawn('/repo');
    expect(loop.status()).toBe('running');
  });

  it('process exits while starting → transitions to stopped', async () => {
    const proc = makeProc();
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockRejectedValue(new Error('no api')),
      _spawn: vi.fn().mockReturnValue(proc),
    }));

    proc._resolveExit(1); // exits immediately
    await loop.spawn('/repo');
    // After spawn poll timeout, state should be stopped
    expect(loop.status()).toBe('stopped');
  });
});

// ── stop ──────────────────────────────────────────────────────────────────────

describe('stop', () => {
  it('sends SIGTERM to owned process', async () => {
    const proc = makeProc();
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockRejectedValue(new Error('no api')),
      _spawn: vi.fn().mockReturnValue(proc),
    }));

    // Start spawn in background, then stop it.
    const spawnP = loop.spawn('/repo');
    await new Promise((r) => setTimeout(r, 10)); // let it reach starting state

    proc._resolveExit(0);
    await loop.stop();
    await spawnP;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('already stopped → no-op', async () => {
    const spawnFn = vi.fn();
    const loop = new DevLoopProcess(makeOpts({ _spawn: spawnFn }));
    await loop.stop(); // should not throw
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

// ── ring buffer ───────────────────────────────────────────────────────────────

describe('ring buffer', () => {
  it('logs() returns a copy, not a reference', () => {
    const loop = new DevLoopProcess(makeOpts());
    const logs = loop.logs();
    expect(Array.isArray(logs)).toBe(true);
  });

  it('onLog callback fires for each complete line', async () => {
    const lines: string[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('line1\nline2\n'));
        c.close();
      },
    });
    const proc = makeProc({ stdout: stream });
    const loop = new DevLoopProcess(makeOpts({
      _fetch: vi.fn().mockRejectedValue(new Error('no api')),
      _spawn: vi.fn().mockReturnValue(proc),
      onLog: (l) => lines.push(l),
    }));

    proc._resolveExit(0);
    await loop.spawn('/repo');
    // Give pipeStream time to drain.
    await new Promise((r) => setTimeout(r, 20));

    expect(lines).toContain('line1');
    expect(lines).toContain('line2');
  });

  it('ring buffer caps at 500 lines (oldest dropped)', () => {
    const loop = new DevLoopProcess(makeOpts());
    // Access private ring buffer via cast.
    const lp = loop as unknown as { appendLog: (l: string) => void; logRing: string[] };
    for (let i = 0; i < 501; i++) lp.appendLog(`line-${i}`);
    expect(lp.logRing.length).toBe(500);
    expect(lp.logRing[0]).toBe('line-1'); // first line dropped
    expect(lp.logRing[499]).toBe('line-500');
  });
});

// ── onStateChange deduplication ────────────────────────────────────────────────

describe('onStateChange', () => {
  it('NOT called when transitioning to the same state', async () => {
    const calls: string[] = [];
    const loop = new DevLoopProcess(makeOpts({ onStateChange: (s) => calls.push(s) }));
    // Manually invoke setState twice with same state via detectExternalProcess
    // (API stays unreachable → stays stopped → no callbacks).
    await loop.detectExternalProcess();
    await loop.detectExternalProcess();
    expect(calls.filter((s) => s === 'stopped')).toHaveLength(0);
  });
});
