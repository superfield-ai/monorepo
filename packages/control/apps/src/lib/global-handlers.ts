/**
 * @file global-handlers.ts
 *
 * Installs `window.onerror` and `window.onunhandledrejection` so that uncaught
 * exceptions and unhandled promise rejections are captured into the DebugStore
 * IN ADDITION TO the browser's default console output. The default behaviour
 * is preserved on purpose — operators reading DevTools should still see the
 * raw stack, and Playwright's `pageerror` listener should still fire so a
 * stray unhandled error in app code fails the test (the right outcome).
 *
 * These handlers are paired with the React `ErrorBoundary` (see
 * components/ErrorBoundary.tsx) which catches render-time errors. Together
 * they close every escape hatch the runtime offers — but they are a safety
 * net, not a silencer. The real contract is "no error is unhandled at the
 * source": every fetch/EventSource/WebSocket call returns a typed
 * `Result<T, AppError>`, every component is inside an ErrorBoundary, and
 * any operation that can fail is awaited inside a Result-aware path. If the
 * net catches anything it is a bug to fix, not a state to ignore.
 */

import { debugStore } from "./debug-store";

let installed = false;

export function installGlobalErrorHandlers(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    debugStore.record({
      level: "error",
      source: "window",
      message: event.message || "Uncaught error",
      stack: event.error instanceof Error ? event.error.stack : undefined,
      context: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
    // Do NOT call event.preventDefault(). The browser default (logging the
    // error to the JS console) is preserved so DevTools and Playwright still
    // see it — the DebugView is an additional surface, not a replacement.
  });

  window.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "Unhandled promise rejection";
      debugStore.record({
        level: "error",
        source: "window",
        message,
        stack: reason instanceof Error ? reason.stack : undefined,
        context: { kind: "unhandledrejection" },
      });
      // Default behaviour preserved — see comment above.
    },
  );
}
