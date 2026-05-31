import type { ChildProcess } from "node:child_process";

export default async function globalTeardown() {
  const proc = (globalThis as Record<string, unknown>).__studioProc as
    | ChildProcess
    | undefined;
  // __apiServer is intentionally absent — no Node API server is started.
  // The sf-serve Rust binary handles all serving (issue #378 / #377).
  const origPath = (globalThis as Record<string, unknown>).__origPath as
    | string
    | undefined;
  const studioLogPath = (globalThis as Record<string, unknown>)
    .__studioLogPath as string | undefined;

  const exitCode = proc?.exitCode;
  proc?.kill("SIGTERM");

  if (origPath !== undefined) {
    process.env.PATH = origPath;
  }

  if (studioLogPath) {
    if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
      // The studio server died during the test run — print the log path so CI
      // can upload it as an artifact.
      process.stderr.write(
        `\n[e2e] Studio server exited with code ${String(exitCode)}.\n` +
          `[e2e] Full output captured at: ${studioLogPath}\n`,
      );
    } else {
      process.stderr.write(`[e2e] Studio server log: ${studioLogPath}\n`);
    }
  }
}
