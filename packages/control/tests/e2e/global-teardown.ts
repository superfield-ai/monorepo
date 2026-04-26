import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';

export default async function globalTeardown() {
  const proc = (globalThis as Record<string, unknown>).__studioProc as ChildProcess | undefined;
  const server = (globalThis as Record<string, unknown>).__apiServer as Server | undefined;
  const origPath = (globalThis as Record<string, unknown>).__origPath as string | undefined;

  proc?.kill('SIGTERM');
  server?.close();

  if (origPath !== undefined) {
    process.env.PATH = origPath;
  }
}
