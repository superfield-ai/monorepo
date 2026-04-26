/**
 * @file console-intercept.ts
 *
 * Wraps `console.error` and `console.warn` so that every call:
 *
 *   1. Forwards a structured entry to the DebugStore.
 *   2. Calls the original console method only in development mode (so the
 *      browser DevTools still shows it during local dev). In production the
 *      console stays silent and the DebugView is the only surface.
 *
 * Operating principle: zero `console.error` / `console.warn` lines on the
 * deployed webapp. The Playwright `expectCleanConsole` fixture asserts this.
 *
 * Idempotent: calling install() twice is a no-op.
 */

import { debugStore } from "./debug-store";

type ConsoleMethod = "error" | "warn";

interface InstallOptions {
  /** When true, also call the original console method after recording. */
  readonly forwardToConsole: boolean;
}

let installed = false;
const originals: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) return arg.message;
  if (typeof arg === "string") return arg;
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function findError(args: unknown[]): Error | undefined {
  for (const a of args) if (a instanceof Error) return a;
  return undefined;
}

export function installConsoleIntercept(opts: InstallOptions): void {
  if (installed) return;
  installed = true;

  for (const method of ["error", "warn"] as const) {
    const original = console[method].bind(console);
    originals[method] = original;
    console[method] = (...args: unknown[]) => {
      const error = findError(args);
      const message = args.map(stringifyArg).join(" ");
      debugStore.record({
        level: method === "error" ? "error" : "warn",
        source: "console",
        message,
        stack: error?.stack,
      });
      if (opts.forwardToConsole) original(...args);
    };
  }
}

/** Test-only: restore native console behaviour. */
export function uninstallConsoleIntercept(): void {
  if (!installed) return;
  for (const method of ["error", "warn"] as const) {
    const original = originals[method];
    if (original) console[method] = original;
  }
  installed = false;
}
