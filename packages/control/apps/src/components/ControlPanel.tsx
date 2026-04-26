/**
 * @file ControlPanel
 *
 * Root component for the Studio browser interface. Renders the two-panel
 * layout: Claude chat sidebar on the left, Superfield app iframe on the right.
 *
 * The SSE connection to GET /studio/cluster/events is owned by
 * ClusterStatusController — this component contains no EventSource
 * instantiation or fetch() calls.
 *
 * Layout (from docs/studio-mode.md — "Browser Interface"):
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  ┌─────────────────┐  ┌─────────────────────┐   │
 *   │  │  Claude Chat    │  │  Superfield App        │   │
 *   │  │  (sidebar)      │  │  (iframe)           │   │
 *   │  └─────────────────┘  └─────────────────────┘   │
 *   └──────────────────────────────────────────────────┘
 *
 * Canonical docs: docs/studio-mode.md
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChatPanel } from './ChatPanel';
import { IframePanel } from './IframePanel';
import { OrchestratorView } from './OrchestratorView';
import { ComponentPreviewPanel } from './ComponentPreviewPanel';
import type { ClusterStatus } from './ClusterStatusIndicator';
import { ClusterStatusController } from '../controllers/ClusterStatusController';

interface ControlPanelProps {
  /** URL loaded in the app iframe; defaults to /app/ */
  appSrc?: string;
  /** SSE endpoint for cluster status events; defaults to /studio/cluster/events */
  clusterEventsUrl?: string;
  /** POST endpoint for chat; defaults to /studio/chat */
  chatEndpoint?: string;
  /** Initial cluster status (used in tests to skip SSE) */
  initialClusterStatus?: ClusterStatus;
  /** Optional pre-constructed controller instance (for testing) */
  clusterStatusController?: ClusterStatusController;
}

/**
 * ControlPanel — two-panel Studio browser interface.
 *
 * The cluster status SSE stream is consumed by ClusterStatusController,
 * instantiated here so both the ChatPanel (status indicator) and IframePanel
 * (reloading overlay) react to the same authoritative state without each
 * opening independent SSE connections.
 */
export function ControlPanel({
  appSrc = '/app/',
  clusterEventsUrl = '/studio/cluster/events',
  chatEndpoint = '/studio/chat',
  initialClusterStatus,
  clusterStatusController: controllerProp,
}: ControlPanelProps) {
  const [clusterStatus, setClusterStatus] = useState<ClusterStatus>(
    initialClusterStatus ?? 'unknown',
  );

  const controllerRef = useRef<ClusterStatusController | null>(null);

  useEffect(() => {
    // Skip SSE when an initial status is injected (test / Storybook mode).
    if (initialClusterStatus !== undefined) return;

    const ctrl = controllerProp ?? new ClusterStatusController({ eventsUrl: clusterEventsUrl });
    controllerRef.current = ctrl;
    const unsub = ctrl.subscribe(setClusterStatus);
    ctrl.connect();

    return () => {
      unsub();
      if (!controllerProp) {
        ctrl.dispose();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterEventsUrl, initialClusterStatus]);

  // Sync override changes after initial render
  useEffect(() => {
    if (initialClusterStatus !== undefined) {
      setClusterStatus(initialClusterStatus);
    }
  }, [initialClusterStatus]);

  const [activeTab, setActiveTab] = useState<'studio' | 'orchestrator' | 'preview'>('studio');

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-zinc-900" data-testid="studio-panel">
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-zinc-700 bg-zinc-800" data-testid="tab-bar">
        <button
          data-testid="tab-studio"
          className={`px-4 py-2 text-sm font-medium ${activeTab === 'studio' ? 'border-b-2 border-blue-400 text-blue-300' : 'text-zinc-400 hover:text-zinc-200'}`}
          onClick={() => setActiveTab('studio')}
        >
          Studio
        </button>
        <button
          data-testid="tab-orchestrator"
          className={`px-4 py-2 text-sm font-medium ${activeTab === 'orchestrator' ? 'border-b-2 border-blue-400 text-blue-300' : 'text-zinc-400 hover:text-zinc-200'}`}
          onClick={() => setActiveTab('orchestrator')}
        >
          Orchestrator
        </button>
        <button
          data-testid="tab-preview"
          className={`px-4 py-2 text-sm font-medium ${activeTab === 'preview' ? 'border-b-2 border-blue-400 text-blue-300' : 'text-zinc-400 hover:text-zinc-200'}`}
          onClick={() => setActiveTab('preview')}
        >
          Preview
        </button>
      </div>

      {/* Studio tab */}
      {activeTab === 'studio' && (
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel — Claude chat sidebar (fixed width) */}
          <div className="w-80 shrink-0 flex flex-col border-r border-zinc-700">
            <ChatPanel
              clusterStatus={clusterStatus}
              chatEndpoint={chatEndpoint}
              clusterEventsUrl={clusterEventsUrl}
            />
          </div>

          {/* Right panel — Superfield app iframe (fills remaining space) */}
          <div className="flex-1 flex flex-col">
            <IframePanel src={appSrc} clusterStatus={clusterStatus} />
          </div>
        </div>
      )}

      {/* Orchestrator tab */}
      {activeTab === 'orchestrator' && (
        <div className="flex-1 overflow-hidden bg-gray-50">
          <OrchestratorView />
        </div>
      )}

      {/* Preview tab — studio-mode component preview panel */}
      {activeTab === 'preview' && (
        <div className="flex-1 overflow-hidden bg-white">
          <ComponentPreviewPanel />
        </div>
      )}
    </div>
  );
}
