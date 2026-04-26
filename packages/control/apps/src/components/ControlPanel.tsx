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

import React, { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { IframePanel } from "./IframePanel";
import { OrchestratorView } from "./OrchestratorView";
import { ComponentPreviewPanel } from "./ComponentPreviewPanel";
import type { ClusterStatus } from "./ClusterStatusIndicator";
import { ClusterStatusController } from "../controllers/ClusterStatusController";
import { DebugView } from "./DebugView";
import { DebugBadge } from "./DebugBadge";
import { Toaster } from "./Toaster";
import { ErrorBoundary } from "./ErrorBoundary";
import { ConnectionBanner } from "./ConnectionBanner";
import { DeployView } from "./DeployView";
import {
  ViewportToolbar,
  VIEWPORT_WIDTHS,
  loadViewport,
  saveViewport,
  type Viewport,
} from "./ViewportToolbar";
import { debugStore } from "../lib/debug-store";

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
  /** When true, hide the dev-loop ConnectionBanner (tests / Storybook). */
  hideConnectionBanner?: boolean;
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
  appSrc = "/app/",
  clusterEventsUrl = "/studio/cluster/events",
  chatEndpoint = "/studio/chat",
  initialClusterStatus,
  clusterStatusController: controllerProp,
  hideConnectionBanner = false,
}: ControlPanelProps) {
  const [clusterStatus, setClusterStatus] = useState<ClusterStatus>(
    initialClusterStatus ?? "unknown",
  );

  const controllerRef = useRef<ClusterStatusController | null>(null);

  useEffect(() => {
    // Skip SSE when an initial status is injected (test / Storybook mode).
    if (initialClusterStatus !== undefined) return;

    const ctrl =
      controllerProp ??
      new ClusterStatusController({ eventsUrl: clusterEventsUrl });
    controllerRef.current = ctrl;
    const unsub = ctrl.subscribe(setClusterStatus);
    ctrl.connect();

    return () => {
      unsub();
      if (!controllerProp) {
        ctrl.dispose();
      }
    };
  }, [clusterEventsUrl, initialClusterStatus]);

  // Sync override changes after initial render
  useEffect(() => {
    if (initialClusterStatus !== undefined) {
      setClusterStatus(initialClusterStatus);
    }
  }, [initialClusterStatus]);

  const [activeTab, setActiveTab] = useState<
    "studio" | "orchestrator" | "preview" | "deploy" | "debug"
  >("studio");

  const [viewport, setViewportState] = useState<Viewport>(() => loadViewport());
  const setViewport = (v: Viewport): void => {
    setViewportState(v);
    saveViewport(v);
  };

  // DB6 — record a route breadcrumb each time the active tab changes so the
  // DebugView timeline can correlate UI events with the user's location.
  useEffect(() => {
    debugStore.breadcrumb({
      category: "route",
      message: `tab: ${activeTab}`,
      data: { tab: activeTab },
    });
  }, [activeTab]);

  return (
    <div
      className="flex h-screen w-full flex-col overflow-hidden bg-zinc-900"
      data-testid="studio-panel"
    >
      {!hideConnectionBanner && <ConnectionBanner />}
      {/* Tab bar */}
      <div
        className="flex shrink-0 border-b border-zinc-700 bg-zinc-800"
        data-testid="tab-bar"
      >
        <button
          data-testid="tab-studio"
          className={`px-4 py-2 text-sm font-medium ${activeTab === "studio" ? "border-b-2 border-blue-400 text-blue-300" : "text-zinc-400 hover:text-zinc-200"}`}
          onClick={() => setActiveTab("studio")}
        >
          Studio
        </button>
        <button
          data-testid="tab-orchestrator"
          className={`px-4 py-2 text-sm font-medium ${activeTab === "orchestrator" ? "border-b-2 border-blue-400 text-blue-300" : "text-zinc-400 hover:text-zinc-200"}`}
          onClick={() => setActiveTab("orchestrator")}
        >
          Orchestrator
        </button>
        <button
          data-testid="tab-preview"
          className={`px-4 py-2 text-sm font-medium ${activeTab === "preview" ? "border-b-2 border-blue-400 text-blue-300" : "text-zinc-400 hover:text-zinc-200"}`}
          onClick={() => setActiveTab("preview")}
        >
          Preview
        </button>
        <button
          data-testid="tab-deploy"
          className={`px-4 py-2 text-sm font-medium ${activeTab === "deploy" ? "border-b-2 border-blue-400 text-blue-300" : "text-zinc-400 hover:text-zinc-200"}`}
          onClick={() => setActiveTab("deploy")}
        >
          Deploy
        </button>
        <DebugBadge
          active={activeTab === "debug"}
          onClick={() => setActiveTab("debug")}
        />
      </div>

      {/* Studio tab */}
      {activeTab === "studio" && (
        <ErrorBoundary label="Studio">
          <div className="flex flex-1 overflow-hidden">
            <div className="w-80 shrink-0 flex flex-col border-r border-zinc-700">
              <ChatPanel
                clusterStatus={clusterStatus}
                chatEndpoint={chatEndpoint}
                clusterEventsUrl={clusterEventsUrl}
              />
            </div>
            <div className="flex-1 flex flex-col">
              <ViewportToolbar value={viewport} onChange={setViewport} />
              <IframePanel
                src={appSrc}
                clusterStatus={clusterStatus}
                iframeWidth={VIEWPORT_WIDTHS[viewport]}
              />
            </div>
          </div>
        </ErrorBoundary>
      )}

      {/* Orchestrator tab */}
      {activeTab === "orchestrator" && (
        <ErrorBoundary label="Orchestrator">
          <div className="flex-1 overflow-hidden bg-gray-50">
            <OrchestratorView />
          </div>
        </ErrorBoundary>
      )}

      {/* Preview tab */}
      {activeTab === "preview" && (
        <ErrorBoundary label="Preview">
          <div className="flex-1 overflow-hidden bg-white">
            <ComponentPreviewPanel />
          </div>
        </ErrorBoundary>
      )}

      {/* Deploy tab */}
      {activeTab === "deploy" && (
        <ErrorBoundary label="Deploy">
          <div className="flex-1 overflow-hidden">
            <DeployView />
          </div>
        </ErrorBoundary>
      )}

      {/* Debug tab */}
      {activeTab === "debug" && (
        <ErrorBoundary label="Debug">
          <div className="flex-1 overflow-hidden">
            <DebugView />
          </div>
        </ErrorBoundary>
      )}

      <Toaster />
    </div>
  );
}
