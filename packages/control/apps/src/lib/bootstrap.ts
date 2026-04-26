/**
 * @file bootstrap.ts
 *
 * Single entry point that installs every error-handling primitive in the right
 * order before React mounts. main.tsx calls `bootstrapErrorHandling()` once.
 *
 * Order matters:
 *   1. window.onerror / unhandledrejection — must precede every other handler.
 *   2. console interception — must precede any module that might log.
 *   3. Backend error stream subscription — opens the SSE channel from E7.
 */

import { installGlobalErrorHandlers } from "./global-handlers";
import { installConsoleIntercept } from "./console-intercept";
import { connectBackendDebugStream } from "./backend-debug-stream";

export interface BootstrapOptions {
  /** True in dev / vite, false in production builds. */
  readonly isDev: boolean;
  /** When false, skip the SSE connection (used in tests). */
  readonly connectBackendStream?: boolean;
}

let bootstrapped = false;

export function bootstrapErrorHandling(opts: BootstrapOptions): void {
  if (bootstrapped) return;
  bootstrapped = true;
  installGlobalErrorHandlers();
  installConsoleIntercept({ forwardToConsole: opts.isDev });
  if (opts.connectBackendStream !== false) {
    connectBackendDebugStream("/studio/debug/events");
  }
}
