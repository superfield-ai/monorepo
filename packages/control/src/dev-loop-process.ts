/**
 * @file dev-loop-process.ts
 *
 * Manages the `superfield start <repo>` child process lifecycle.
 *
 * On startup, checks whether a dev loop is already running at the configured
 * API URL. If reachable, enters `running` (externally managed) state without
 * spawning a new process.
 *
 * Process states:
 *   stopped   — no child process, API unreachable
 *   starting  — child process spawned, waiting for API to become reachable
 *   running   — API reachable (owned or externally managed)
 *   stopping  — SIGTERM sent, waiting for exit
 */

import type { Subprocess as _Subprocess } from 'bun';

export type ProcessState = 'stopped' | 'starting' | 'running' | 'stopping';

const RING_BUFFER_SIZE = 500;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const SIGKILL_TIMEOUT_MS = 5000;
const STARTUP_POLL_INTERVAL_MS = 500;
const STARTUP_TIMEOUT_MS = 30_000;

export interface DevLoopProcessOpts {
  apiUrl: string;
  /** Emitted when the process state changes. */
  onStateChange?: (state: ProcessState) => void;
  /** Emitted for each line of stdout/stderr. */
  onLog?: (line: string) => void;
  /** Injected fetch for isApiReachable (tests). */
  _fetch?: typeof fetch;
  /** Injected spawn for subprocess creation (tests). */
  _spawn?: (args: string[], opts: object) => { stdout: ReadableStream<Uint8Array> | null; stderr: ReadableStream<Uint8Array> | null; exited: Promise<number>; pid: number; kill: (signal?: string) => void };
  /** Poll interval ms (tests may set to 0). */
  _pollIntervalMs?: number;
  /** Startup timeout ms (tests may shorten). */
  _startupTimeoutMs?: number;
}

export class DevLoopProcess {
  private state: ProcessState = 'stopped';
  private proc: ReturnType<DevLoopProcessOpts['_spawn'] & {}> | null = null;
  private logRing: string[] = [];
  private readonly apiUrl: string;
  private readonly onStateChange?: (state: ProcessState) => void;
  private readonly onLog?: (line: string) => void;
  private readonly _fetch: typeof fetch;
  private readonly _spawn: NonNullable<DevLoopProcessOpts['_spawn']>;
  private readonly _pollIntervalMs: number;
  private readonly _startupTimeoutMs: number;
  private externallyManaged = false;

  constructor(opts: DevLoopProcessOpts) {
    this.apiUrl = opts.apiUrl;
    this.onStateChange = opts.onStateChange;
    this.onLog = opts.onLog;
    this._fetch = opts._fetch ?? globalThis.fetch;
    this._spawn = opts._spawn ?? ((args, o) => Bun.spawn(args as string[], o as Parameters<typeof Bun.spawn>[1]));
    this._pollIntervalMs = opts._pollIntervalMs ?? STARTUP_POLL_INTERVAL_MS;
    this._startupTimeoutMs = opts._startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  }

  /** Probe GET <apiUrl>/health. Returns true if HTTP 200. */
  async isApiReachable(): Promise<boolean> {
    try {
      const res = await this._fetch(`${this.apiUrl}/health`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  status(): ProcessState {
    return this.state;
  }

  pid(): number | undefined {
    return this.proc?.pid;
  }

  logs(): string[] {
    return [...this.logRing];
  }

  /**
   * Check whether a dev loop is already running at the API URL.
   * Call once at startup before any spawn() attempts.
   */
  async detectExternalProcess(): Promise<void> {
    if (await this.isApiReachable()) {
      this.externallyManaged = true;
      this.setState('running');
    }
  }

  /**
   * Spawn `superfield start <repo>`. Does nothing if already running or stopping.
   */
  async spawn(repo: string, opts: { slotCount?: number } = {}): Promise<void> {
    if (this.state === 'running' || this.state === 'starting' || this.state === 'stopping') {
      return;
    }

    const args = ['superfield', 'start', repo];
    if (opts.slotCount) args.push(String(opts.slotCount));

    this.proc = this._spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });

    this.setState('starting');

    // Pipe stdout + stderr to ring buffer.
    void this.pipeStream(this.proc.stdout);
    void this.pipeStream(this.proc.stderr);

    // Watch for exit.
    void this.proc.exited.then(() => {
      this.proc = null;
      if (this.state !== 'stopping') {
        this.setState('stopped');
      } else {
        this.setState('stopped');
      }
    });

    // Poll until API becomes reachable (up to _startupTimeoutMs).
    const deadline = Date.now() + this._startupTimeoutMs;
    while (Date.now() < deadline && this.state === 'starting') {
      await new Promise<void>((r) => setTimeout(r, this._pollIntervalMs));
      if (await this.isApiReachable()) {
        this.setState('running');
        return;
      }
    }

    // If still starting, it timed out — leave as starting (will transition to
    // stopped when the process exits).
  }

  /** Send SIGTERM → SIGKILL after 5 s. */
  async stop(): Promise<void> {
    if (this.externallyManaged) {
      this.externallyManaged = false;
      this.setState('stopped');
      return;
    }

    if (!this.proc || this.state === 'stopped') return;

    this.setState('stopping');
    this.proc.kill('SIGTERM');

    const killTimeout = setTimeout(() => {
      if (this.proc) this.proc.kill('SIGKILL');
    }, SIGKILL_TIMEOUT_MS);

    await this.proc.exited;
    clearTimeout(killTimeout);
  }

  private setState(next: ProcessState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  private async pipeStream(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        this.appendLog(line);
      }
    }
    if (buf) this.appendLog(buf);
  }

  private appendLog(line: string): void {
    if (this.logRing.length >= RING_BUFFER_SIZE) {
      this.logRing.shift();
    }
    this.logRing.push(line);
    this.onLog?.(line);
  }
}
