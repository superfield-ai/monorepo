/**
 * @file ClusterStatusIndicator
 *
 * Displays a persistent cluster health indicator in the Studio chat panel.
 * SSE connection is managed by ClusterStatusController — this component
 * contains no EventSource instantiation.
 *
 * Canonical docs: docs/studio-mode.md — "Cluster Status Stream"
 */

import React, { useEffect, useRef, useState } from "react";
import {
  ClusterStatusController,
  type ClusterStatus,
} from "../controllers/ClusterStatusController";

export type { ClusterStatus };

interface ClusterStatusIndicatorProps {
  /** Override status for testing without SSE (skips SSE connection when set) */
  statusOverride?: ClusterStatus;
  /** SSE endpoint; defaults to /studio/cluster/events */
  eventsUrl?: string;
  /** Optional pre-constructed controller instance (for testing) */
  controller?: ClusterStatusController;
}

const STATUS_CONFIG: Record<
  ClusterStatus,
  { label: string; dotColor: string; pulse: boolean }
> = {
  healthy: {
    label: "CLUSTER NOMINAL",
    dotColor: "var(--status-nominal)",
    pulse: false,
  },
  restarting: {
    label: "CLUSTER RESTARTING",
    dotColor: "var(--status-caution)",
    pulse: true,
  },
  degraded: {
    label: "CLUSTER DEGRADED",
    dotColor: "var(--status-critical)",
    pulse: false,
  },
  unknown: {
    label: "CLUSTER UNKNOWN",
    dotColor: "var(--fg-3)",
    pulse: false,
  },
};

/**
 * ClusterStatusIndicator — reads cluster status from ClusterStatusController
 * (which consumes SSE at /studio/cluster/events) and renders a dot + label
 * showing healthy, restarting, or degraded.
 */
export function ClusterStatusIndicator({
  statusOverride,
  eventsUrl = "/studio/cluster/events",
  controller: controllerProp,
}: ClusterStatusIndicatorProps) {
  const [status, setStatus] = useState<ClusterStatus>(
    statusOverride ?? "unknown",
  );

  const controllerRef = useRef<ClusterStatusController | null>(null);

  useEffect(() => {
    // When a status override is provided (e.g. in tests), skip the SSE connection.
    if (statusOverride !== undefined) {
      setStatus(statusOverride);
      return;
    }

    const ctrl = controllerProp ?? new ClusterStatusController({ eventsUrl });
    controllerRef.current = ctrl;
    const unsub = ctrl.subscribe(setStatus);
    ctrl.connect();

    return () => {
      unsub();
      if (!controllerProp) {
        ctrl.dispose();
      }
    };
  }, [eventsUrl, statusOverride]);

  // Sync override changes after initial render
  useEffect(() => {
    if (statusOverride !== undefined) {
      setStatus(statusOverride);
    }
  }, [statusOverride]);

  const config = STATUS_CONFIG[status];

  return (
    <div
      aria-label={`Cluster status: ${status}`}
      data-testid="cluster-status-indicator"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-1)",
        padding: "var(--sp-1) var(--sp-2)",
        background: "var(--bg-raised)",
        border: "1px solid var(--border-subtle)",
        color: "var(--fg-1)",
      }}
    >
      <span
        aria-hidden="true"
        data-pill="true"
        style={{
          width: 8,
          height: 8,
          flexShrink: 0,
          background: config.dotColor,
          animation: config.pulse
            ? "var(--pulse-anim, pulse 1.5s ease-in-out infinite)"
            : undefined,
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          fontWeight: 500,
          letterSpacing: "var(--ls-wider)",
          color: config.dotColor,
        }}
      >
        {config.label}
      </span>
    </div>
  );
}
