/**
 * @file process-manager.ts
 *
 * Child-process lifecycle management for the Studio Server.
 *
 * Canonical spec: docs/studio-mode.md — "Stopping Studio Mode" section.
 *
 * The studio server is the sole owner of all child processes (Claude CLI,
 * kubectl subprocesses) for the duration of a session. This module tracks
 * every spawned child process and coordinates the graceful-shutdown sequence
 * described in the spec:
 *
 *   1. Send SIGTERM to all tracked child processes.
 *   2. Wait up to SIGKILL_TIMEOUT_MS (default 5 000 ms) for each to exit.
 *   3. Send SIGKILL to any process that has not exited within the timeout.
 *
 * Usage:
 *
 *   const pm = new ProcessManager();
 *   const proc = pm.spawn(['kubectl', 'get', 'pods', '--watch'], { ... });
 *   // ...
 *   await pm.shutdown(); // called by the SIGINT handler in index.ts
 *
 * Integration points discovered during scout pass (issue #163):
 *   - index.ts registers the SIGINT handler and calls pm.shutdown().
 *   - cluster-watch.ts spawns the kubectl --watch subprocess via pm.spawn().
 */

export const SIGKILL_TIMEOUT_MS = 5_000;

export interface ManagedProcess {
  /** Bun subprocess handle. */
  proc: ReturnType<typeof Bun.spawn>;
  /** Human-readable label for logging. */
  label: string;
}

export class ProcessManager {
  private readonly children: ManagedProcess[] = [];

  /**
   * Spawn a child process and register it for lifecycle management.
   *
   * All options are forwarded to Bun.spawn verbatim. The spawned process is
   * tracked internally and will receive SIGTERM / SIGKILL during shutdown.
   *
   * @param cmd  Command and arguments array.
   * @param opts Bun.spawn options (stdout, stderr, cwd, env, …).
   * @param label Human-readable name for log messages.
   */
  spawn(
    cmd: string[],
    opts: Parameters<typeof Bun.spawn>[1],
    label: string = cmd[0] ?? "(unnamed)",
  ): ReturnType<typeof Bun.spawn> {
    const proc = Bun.spawn(cmd, opts);
    this.children.push({ proc, label });
    return proc;
  }

  /**
   * Register an already-spawned process for lifecycle management.
   */
  register(proc: ReturnType<typeof Bun.spawn>, label: string): void {
    this.children.push({ proc, label });
  }

  /**
   * Graceful shutdown sequence:
   *
   *   1. Send SIGTERM to all living child processes.
   *   2. Wait up to SIGKILL_TIMEOUT_MS for each to exit.
   *   3. SIGKILL any survivors.
   *
   * The method resolves once all children have exited (or been killed).
   * It never rejects — errors during kill are swallowed and logged.
   */
  async shutdown(): Promise<void> {
    if (this.children.length === 0) return;

    console.log(
      `[studio] Sending SIGTERM to ${this.children.length} child process(es)…`,
    );

    const killPromises = this.children.map(async ({ proc, label }) => {
      try {
        // exitCode is set once the process has already exited.
        if (proc.exitCode !== null) return;

        proc.kill("SIGTERM");

        const timedOut = await Promise.race([
          proc.exited.then(() => false),
          new Promise<true>((resolve) =>
            setTimeout(() => resolve(true), SIGKILL_TIMEOUT_MS),
          ),
        ]);

        if (timedOut) {
          console.warn(
            `[studio] ${label} did not exit within ${SIGKILL_TIMEOUT_MS}ms — SIGKILL`,
          );
          try {
            proc.kill("SIGKILL");
          } catch {
            // Process may have exited between the race and the kill call.
          }
          await proc.exited;
        }
      } catch (err) {
        // Best-effort — log and move on.
        console.error(
          `[studio] Error shutting down child process "${label}":`,
          err,
        );
      }
    });

    await Promise.all(killPromises);
    this.children.length = 0;
    console.log("[studio] All child processes stopped.");
  }

  /** Number of currently tracked child processes. */
  get count(): number {
    return this.children.length;
  }
}
