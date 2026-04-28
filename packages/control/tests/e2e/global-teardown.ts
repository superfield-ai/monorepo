import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

export default async function globalTeardown() {
  const proc = (globalThis as Record<string, unknown>).__studioProc as
    | ChildProcess
    | undefined;
  const server = (globalThis as Record<string, unknown>).__apiServer as
    | Server
    | undefined;
  const origPath = (globalThis as Record<string, unknown>).__origPath as
    | string
    | undefined;
  const studioLogPath = (globalThis as Record<string, unknown>)
    .__studioLogPath as string | undefined;

  const exitCode = proc?.exitCode;
  proc?.kill("SIGTERM");
  server?.close();

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
