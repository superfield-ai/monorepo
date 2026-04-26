/**
 * @file ClusterStatusIndicator
 *
 * Displays a persistent cluster health indicator in the Studio chat panel.
 * SSE connection is managed by ClusterStatusController — this component
 * contains no EventSource instantiation.
 *
 * Canonical docs: docs/studio-mode.md — "Cluster Status Stream"
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  ClusterStatusController,
  type ClusterStatus,
} from '../controllers/ClusterStatusController';

export type { ClusterStatus };

interface ClusterStatusIndicatorProps {
  /** Override status for testing without SSE (skips SSE connection when set) */
  statusOverride?: ClusterStatus;
  /** SSE endpoint; defaults to /studio/cluster/events */
  eventsUrl?: string;
  /** Optional pre-constructed controller instance (for testing) */
  controller?: ClusterStatusController;
}

const STATUS_CONFIG: Record<ClusterStatus, { label: string; dotClass: string; textClass: string }> =
  {
    healthy: {
      label: 'Cluster healthy',
      dotClass: 'bg-emerald-400',
      textClass: 'text-emerald-700',
    },
    restarting: {
      label: 'Cluster restarting',
      dotClass: 'bg-amber-400 animate-pulse',
      textClass: 'text-amber-700',
    },
    degraded: {
      label: 'Cluster degraded',
      dotClass: 'bg-red-400',
      textClass: 'text-red-700',
    },
    unknown: {
      label: 'Cluster status unknown',
      dotClass: 'bg-zinc-300',
      textClass: 'text-zinc-500',
    },
  };

/**
 * ClusterStatusIndicator — reads cluster status from ClusterStatusController
 * (which consumes SSE at /studio/cluster/events) and renders a dot + label
 * showing healthy, restarting, or degraded.
 */
export function ClusterStatusIndicator({
  statusOverride,
  eventsUrl = '/studio/cluster/events',
  controller: controllerProp,
}: ClusterStatusIndicatorProps) {
  const [status, setStatus] = useState<ClusterStatus>(statusOverride ?? 'unknown');

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
      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-50 border border-zinc-200"
      aria-label={`Cluster status: ${status}`}
      data-testid="cluster-status-indicator"
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${config.dotClass}`} aria-hidden="true" />
      <span className={`text-xs font-medium ${config.textClass}`}>{config.label}</span>
    </div>
  );
}
