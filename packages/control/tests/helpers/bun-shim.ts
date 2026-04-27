/**
 * Bun API shim for Vitest's Node environment.
 *
 * Unit tests run in vitest with `environment: 'node'`, so the Bun global is
 * not available. This setup file installs a minimal Bun.spawn stub that
 * returns a fake process object. Since readProcStdout is mocked at the I/O
 * boundary in each test file, the fake stdout stream is never actually read.
 *
 * This replaces per-test globalThis.Bun patching (Issue #23).
 */

if (typeof globalThis.Bun === "undefined") {
  const noop = () => {};
  (globalThis as Record<string, unknown>).Bun = {
    spawn: (..._args: unknown[]) => ({
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      pid: 0,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: noop,
      ref: noop,
      unref: noop,
      stdin: null,
    }),
  };
}
