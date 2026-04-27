/**
 * @file IframePanel
 *
 * Right panel of the Studio browser interface. Renders the Superfield app inside
 * an iframe pointing at CONTROL_PORT/app/ (proxy target is the cluster's web
 * service).
 *
 * During hot-swaps (cluster status is "restarting"), a semi-transparent overlay
 * is shown over the iframe:
 *
 *   ⟳  Reloading — cluster is restarting…
 *
 * When the cluster returns to "healthy" the overlay is cleared and the iframe
 * is reloaded automatically so the developer sees the updated application.
 *
 * Canonical docs: docs/studio-mode.md — "Browser Interface", "Hot-Swap Flow"
 */

import React, { useEffect, useRef, useState } from "react";
import type { ClusterStatus } from "./ClusterStatusIndicator";
import {
  IframeOverlay,
  type IframeFailureMode,
} from "./IframeOverlay";

interface IframePanelProps {
  /** URL loaded in the iframe. Defaults to /app/ (studio proxy target). */
  src?: string;
  /** Current cluster status forwarded from the parent SSE consumer. */
  clusterStatus: ClusterStatus;
  /**
   * Optional CSS width applied to the iframe (D4 viewport toolbar). When
   * undefined, the iframe stretches to fill its container.
   */
  iframeWidth?: number | string;
  /**
   * Test seam: drive the failure overlay directly. When set, IframePanel
   * shows the overlay regardless of internal load state. Used by E14 component
   * tests and the error-handling Playwright spec.
   */
  failureModeOverride?: IframeFailureMode;
  /** Stderr tail surfaced in the build-error overlay. */
  buildStderr?: string;
}

/**
 * IframePanel renders the embedded Superfield app and manages the reloading
 * overlay lifecycle based on cluster status transitions.
 */
export function IframePanel({
  src = "/app/",
  clusterStatus,
  iframeWidth,
  failureModeOverride,
  buildStderr,
}: IframePanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [failureMode, setFailureMode] = useState<IframeFailureMode | null>(
    null,
  );
  const prevStatusRef = useRef<ClusterStatus>(clusterStatus);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = clusterStatus;

    if (clusterStatus === "restarting") {
      // Show overlay when cluster begins restarting.
      setOverlayVisible(true);
    } else if (clusterStatus === "healthy" && prev === "restarting") {
      // Cluster returned to healthy after a restart — hide overlay and reload.
      setOverlayVisible(false);
      if (iframeRef.current) {
        iframeRef.current.src = src;
      }
    }

    // E14: surface a cluster-down failure overlay when the cluster reports it
    // is unhealthy or unknown for long enough that the iframe is unusable.
    if (clusterStatus === "degraded" || clusterStatus === "unknown") {
      setFailureMode("cluster-down");
    } else if (clusterStatus === "healthy") {
      setFailureMode(null);
    }
  }, [clusterStatus, src]);

  function handleIframeError() {
    // The iframe's `error` event fires for cross-origin or full-document load
    // failures. Without cluster context we fall back to "build-error" — the
    // operator gets a Retry button either way.
    if (clusterStatus === "healthy") {
      setFailureMode("build-error");
    } else {
      setFailureMode("cluster-down");
    }
  }

  function handleRetry() {
    setFailureMode(null);
    if (iframeRef.current) iframeRef.current.src = src;
  }

  function handleResetToRoot() {
    setFailureMode(null);
    if (iframeRef.current) iframeRef.current.src = "/app/";
  }

  const effectiveFailureMode = failureModeOverride ?? failureMode;

  const iframeStyle: React.CSSProperties =
    iframeWidth !== undefined
      ? {
          width:
            typeof iframeWidth === "number" ? `${iframeWidth}px` : iframeWidth,
          maxWidth: "100%",
        }
      : {};

  return (
    <div
      className="relative flex-1 h-full bg-zinc-950 flex justify-center"
      data-testid="iframe-panel"
    >
      <iframe
        ref={iframeRef}
        src={src}
        title="Superfield app"
        className={
          iframeWidth !== undefined
            ? "h-full border-0"
            : "w-full h-full border-0"
        }
        style={iframeStyle}
        data-testid="app-iframe"
        onError={handleIframeError}
      />

      {effectiveFailureMode && !overlayVisible && (
        <IframeOverlay
          mode={effectiveFailureMode}
          failedPath={
            effectiveFailureMode === "not-found"
              ? src.replace(/^\/app/, "")
              : undefined
          }
          buildStderr={buildStderr}
          onRetry={handleRetry}
          onResetToRoot={handleResetToRoot}
        />
      )}

      {/* Reloading overlay — visible during hot-swaps */}
      {overlayVisible && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm z-10"
          data-testid="reloading-overlay"
          aria-live="polite"
          aria-label="Reloading — cluster is restarting"
        >
          <div className="flex flex-col items-center gap-3 text-zinc-100">
            <svg
              className="w-8 h-8 animate-spin text-indigo-400"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <p className="text-sm font-medium">
              Reloading — cluster is restarting…
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
