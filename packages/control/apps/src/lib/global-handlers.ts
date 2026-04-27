/**
 * @file global-handlers.ts
 *
 * Installs `window.onerror` and `window.onunhandledrejection` so that uncaught
 * exceptions and unhandled promise rejections are captured into the DebugStore
 * instead of bubbling silently into the browser console.
 *
 * These handlers are paired with the React `ErrorBoundary` (see
 * components/ErrorBoundary.tsx) which catches render-time errors. Together they
 * close every escape hatch the runtime offers.
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
    // Suppress the default browser console output — the DebugView is the
    // canonical surface. Returning true cancels the event.
    event.preventDefault();
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
      event.preventDefault();
    },
  );
}
