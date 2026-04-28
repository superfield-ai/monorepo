/**
 * IframeOverlay — failure-mode overlay for the embedded Superfield app iframe.
 *
 * Three modes, each with a recovery action:
 *
 *   cluster-down  → "APP UNREACHABLE" + "REBUILD" / "RETRY"
 *                   (POST /studio/rebuild, surfaces toast on failure)
 *   build-error   → "BUILD FAILED" + stderr tail + "RETRY"
 *                   (reloads the iframe)
 *   not-found     → "ROUTE NOT FOUND: /<path>" + "BACK TO /"
 *                   (resets iframe src to /app/)
 *
 * Visuals follow the Superfield Control Room design system: bg-overlay
 * backdrop, bg-raised flat panel with a status-coloured 1px border,
 * mono ALL-CAPS labels, sharp corners. Behaviour, event handlers and
 * data-testid values are preserved.
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

const MODE_BORDER: Record<IframeFailureMode, string> = {
  "cluster-down": "var(--accent-red)",
  "build-error": "var(--accent-red)",
  "not-found": "var(--accent-amber)",
};

const MODE_BADGE: Record<IframeFailureMode, { label: string; cls: string }> = {
  "cluster-down": { label: "FAULT", cls: "badge badge-critical" },
  "build-error": { label: "FAULT", cls: "badge badge-critical" },
  "not-found": { label: "CAUTION", cls: "badge badge-caution" },
};

const primaryButton: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--accent-cyan)",
  color: "var(--accent-cyan)",
  padding: "var(--sp-1) var(--sp-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
  cursor: "pointer",
};

const ghostButton: React.CSSProperties = {
  ...primaryButton,
  border: "1px solid var(--border-default)",
  color: "var(--fg-1)",
};

export function IframeOverlay({
  mode,
  failedPath,
  buildStderr,
  onResetToRoot,
  onRetry,
  rebuildEndpoint = "/studio/rebuild",
}: IframeOverlayProps) {
  const [rebuilding, setRebuilding] = React.useState(false);
  const [buildLog, setBuildLog] = React.useState<string[]>([]);
  const logRef = React.useRef<HTMLPreElement>(null);

  // Auto-scroll the log panel as lines arrive.
  React.useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [buildLog]);

  async function handleRebuild() {
    setRebuilding(true);
    setBuildLog([]);

    const result = await fetchJson<{ ok: boolean; jobId: string }>(
      rebuildEndpoint,
      { method: "POST" },
    );

    if (!result.ok) {
      setRebuilding(false);
      toastStore.show({
        severity: "error",
        title: "RESOURCE FAULT — REBUILD",
        message: result.error.message,
      });
      return;
    }

    // Stream build logs from the SSE endpoint.
    const logUrl = `${rebuildEndpoint}/log?job=${encodeURIComponent(result.value.jobId)}`;
    const es = new EventSource(logUrl);

    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const line = JSON.parse(e.data) as string;
        setBuildLog((prev) => [...prev, line]);
      } catch {
        setBuildLog((prev) => [...prev, e.data]);
      }
    };

    es.addEventListener("done", (e: Event) => {
      es.close();
      setRebuilding(false);
      try {
        const msg = JSON.parse((e as MessageEvent<string>).data) as string;
        toastStore.show({
          severity: "success",
          title: "REBUILD — COMPLETE",
          message: msg,
        });
      } catch {
        /* ignore */
      }
      if (onRetry) onRetry();
    });

    es.addEventListener("error", (e: Event) => {
      es.close();
      setRebuilding(false);
      let msg = "Build failed — check the log above.";
      try {
        msg = JSON.parse((e as MessageEvent<string>).data) as string;
      } catch {
        /* use default */
      }
      toastStore.show({
        severity: "error",
        title: "REBUILD FAILED",
        message: msg,
      });
    });
  }

  const badge = MODE_BADGE[mode];

  return (
    <div
      role="alert"
      data-testid="iframe-overlay"
      data-mode={mode}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-overlay)",
        padding: "var(--sp-6)",
      }}
    >
      <div
        style={{
          display: "flex",
          maxWidth: 560,
          flexDirection: "column",
          gap: "var(--sp-3)",
          background: "var(--bg-raised)",
          border: `1px solid ${MODE_BORDER[mode]}`,
          padding: "var(--sp-6)",
          color: "var(--fg-1)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
          }}
        >
          <span className={badge.cls} data-pill="true">
            {badge.label}
          </span>
          <h2 className="h3" style={{ margin: 0 }}>
            {mode === "cluster-down" && "APP UNREACHABLE"}
            {mode === "build-error" && "BUILD FAILED"}
            {mode === "not-found" && "ROUTE NOT FOUND"}
          </h2>
        </div>

        {mode === "cluster-down" && (
          <>
            <p style={{ color: "var(--fg-2)" }}>
              The cluster is unhealthy or not running. The Superfield app is not
              currently being served.
            </p>
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              <button
                type="button"
                onClick={handleRebuild}
                disabled={rebuilding}
                data-testid="iframe-overlay-rebuild"
                style={{
                  ...primaryButton,
                  opacity: rebuilding ? 0.6 : 1,
                  cursor: rebuilding ? "not-allowed" : "pointer",
                }}
              >
                {rebuilding ? "REBUILDING…" : "REBUILD"}
              </button>
              <button
                type="button"
                onClick={onRetry}
                data-testid="iframe-overlay-retry"
                style={ghostButton}
              >
                RETRY
              </button>
            </div>
            {buildLog.length > 0 && (
              <pre
                ref={logRef}
                data-testid="iframe-overlay-build-log"
                style={{
                  maxHeight: 240,
                  overflow: "auto",
                  background: "var(--bg-void)",
                  border: "1px solid var(--border-subtle)",
                  padding: "var(--sp-3)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  lineHeight: "var(--lh-normal)",
                  color: "var(--fg-2)",
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {buildLog.join("\n")}
              </pre>
            )}
          </>
        )}

        {mode === "build-error" && (
          <>
            <p style={{ color: "var(--fg-2)" }}>
              The last rebuild produced errors. Fix the underlying issue and
              retry.
            </p>
            {buildStderr && (
              <pre
                style={{
                  maxHeight: 192,
                  overflow: "auto",
                  background: "var(--bg-void)",
                  border: "1px solid var(--border-subtle)",
                  padding: "var(--sp-3)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  lineHeight: "var(--lh-normal)",
                  color: "var(--accent-red)",
                  margin: 0,
                }}
              >
                {buildStderr}
              </pre>
            )}
            <button
              type="button"
              onClick={onRetry}
              data-testid="iframe-overlay-retry"
              style={{ ...primaryButton, alignSelf: "flex-start" }}
            >
              RETRY
            </button>
          </>
        )}

        {mode === "not-found" && (
          <>
            <p style={{ color: "var(--fg-2)" }}>
              The app does not have a route matching{" "}
              <code style={{ fontSize: "var(--text-xs)" }}>
                {failedPath ?? "this path"}
              </code>
              .
            </p>
            <button
              type="button"
              onClick={onResetToRoot}
              data-testid="iframe-overlay-back"
              style={{ ...primaryButton, alignSelf: "flex-start" }}
            >
              BACK TO /
            </button>
          </>
        )}
      </div>
    </div>
  );
}
