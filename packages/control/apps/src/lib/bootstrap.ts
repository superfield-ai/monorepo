/**
 * @file bootstrap.ts
 *
 * Single entry point that installs the error-handling primitives in the right
 * order before React mounts. main.tsx calls `bootstrapErrorHandling()` once.
 *
 * Operating principle: **no error is unhandled.** Every code path that can
 * fail either (a) returns a typed `Result<T, AppError>` (the `fetch` /
 * `EventSource` / `WebSocket` wrappers in `net.ts`), (b) is caught by an
 * `ErrorBoundary` at a route or panel boundary, or (c) is captured by the
 * global `window.onerror` / `unhandledrejection` handlers as a last resort.
 *
 * Notably we do NOT intercept `console.error` / `console.warn`. The browser
 * console stays a useful diagnostic surface for operators. The
 * `expectCleanConsole` Playwright fixture treats any console.error/warn as a
 * test failure — which is the right enforcement: if something calls
 * `console.error` in app code, that is an unhandled error path that should be
 * fixed at the source, not silenced. Errors we explicitly want to record
 * write to `debugStore.record(...)` directly.
 *
 * Order matters:
 *   1. window.onerror / unhandledrejection — must precede every other handler
 *      so a crash during later bootstrap steps still lands in the DebugStore.
 *   2. Backend error stream subscription — opens the SSE channel from E7 so
 *      backend-side errors and warnings show up in the unified timeline.
 */

import { installGlobalErrorHandlers } from "./global-handlers";
import { connectBackendDebugStream } from "./backend-debug-stream";

export interface BootstrapOptions {
  /** True in dev / vite, false in production builds. */
  readonly isDev: boolean;
  /** When false, skip the SSE connection (used in tests). */
  readonly connectBackendStream?: boolean;
}

let bootstrapped = false;

export function bootstrapErrorHandling(_opts: BootstrapOptions): void {
  if (bootstrapped) return;
  bootstrapped = true;
  installGlobalErrorHandlers();
  if (_opts.connectBackendStream !== false) {
    connectBackendDebugStream("/studio/debug/events");
  }
}
