/**
 * IframeOverlay — failure-mode overlay for the embedded Superfield app iframe.
 *
 * Three modes, each with a recovery action:
 *
 *   cluster-down  → "The deployed app is unreachable" + "Rebuild" button
 *                   (POST /studio/rebuild, surfaces toast on failure)
 *   build-error   → "Last build failed" + stderr tail + "Retry" button
 *                   (reloads the iframe)
 *   not-found     → "Route not found: /<path>" + "Back to /" button
 *                   (resets iframe src to /app/)
 *
 * The overlay is purely presentational — IframePanel (or any other host) owns
 * the failure-detection logic and decides which mode to render.
 */

import React from "react";
import { fetchJson } from "../lib/net";
import { toastStore } from "../lib/toast-store";

export type IframeFailureMode = "cluster-down" | "build-error" | "not-found";

interface IframeOverlayProps {
  mode: IframeFailureMode;
  /** Path that 404'd, used by the not-found mode to show what was requested. */
  failedPath?: string;
  /** Last 30 lines of stderr from the build, shown in the build-error mode. */
  buildStderr?: string;
  /** Action: navigate iframe back to /app/. */
  onResetToRoot?: () => void;
  /** Action: reload the current iframe src. */
  onRetry?: () => void;
  /** Override the rebuild endpoint, defaults to /studio/rebuild. */
  rebuildEndpoint?: string;
}

export function IframeOverlay({
  mode,
  failedPath,
  buildStderr,
  onResetToRoot,
  onRetry,
  rebuildEndpoint = "/studio/rebuild",
}: IframeOverlayProps) {
  const [rebuilding, setRebuilding] = React.useState(false);

  async function handleRebuild() {
    setRebuilding(true);
    const result = await fetchJson<{ ok: boolean }>(rebuildEndpoint, {
      method: "POST",
    });
    setRebuilding(false);
    if (!result.ok) {
      toastStore.show({
        severity: "error",
        title: "Rebuild failed",
        message: result.error.message,
      });
    } else {
      toastStore.show({
        severity: "success",
        title: "Rebuild started",
        message:
          "Cluster is rebuilding the app — the iframe will reload when it's healthy.",
      });
    }
  }

  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/85 p-6 backdrop-blur-sm"
      role="alert"
      data-testid="iframe-overlay"
      data-mode={mode}
    >
      <div className="flex max-w-xl flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-zinc-100 shadow-xl">
        {mode === "cluster-down" && (
          <>
            <h2 className="text-lg font-semibold">App unreachable</h2>
            <p className="text-sm text-zinc-300">
              The cluster is unhealthy or not running. The Superfield app is not
              currently being served.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleRebuild}
                disabled={rebuilding}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
                data-testid="iframe-overlay-rebuild"
              >
                {rebuilding ? "Rebuilding…" : "Rebuild"}
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
                data-testid="iframe-overlay-retry"
              >
                Retry
              </button>
            </div>
          </>
        )}

        {mode === "build-error" && (
          <>
            <h2 className="text-lg font-semibold">App build failed</h2>
            <p className="text-sm text-zinc-300">
              The last rebuild produced errors. Fix the underlying issue and
              retry.
            </p>
            {buildStderr && (
              <pre className="max-h-48 overflow-auto rounded bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-red-300">
                {buildStderr}
              </pre>
            )}
            <button
              type="button"
              onClick={onRetry}
              className="self-start rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
              data-testid="iframe-overlay-retry"
            >
              Retry
            </button>
          </>
        )}

        {mode === "not-found" && (
          <>
            <h2 className="text-lg font-semibold">Route not found</h2>
            <p className="text-sm text-zinc-300">
              The app does not have a route matching{" "}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs">
                {failedPath ?? "this path"}
              </code>
              .
            </p>
            <button
              type="button"
              onClick={onResetToRoot}
              className="self-start rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
              data-testid="iframe-overlay-back"
            >
              Back to /
            </button>
          </>
        )}
      </div>
    </div>
  );
}
