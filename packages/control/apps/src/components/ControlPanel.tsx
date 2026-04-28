/**
 * @file ControlPanel
 *
 * Root component for the Studio browser interface. Three top-level tabs:
 *   - Studio: FeaturePane (feature list + detail + session log)
 *   - Viewport: RouteMap + ViewportToolbar + IframePanel
 *   - Product: DocsViewer + ProductChatPanel
 *
 * The SSE connection to GET /studio/cluster/events is owned by
 * ClusterStatusController — this component contains no EventSource
 * instantiation or fetch() calls.
 *
 * Canonical docs: docs/studio-mode.md
 */

import React, { useEffect, useRef, useState } from "react";
import { IframePanel } from "./IframePanel";
import { FeaturePane } from "./FeaturePane";
import { ProductTab } from "./ProductTab";
import type { ClusterStatus } from "./ClusterStatusIndicator";
import { ClusterStatusController } from "../controllers/ClusterStatusController";
import { DebugView } from "./DebugView";
import { DebugBadge } from "./DebugBadge";
import { Toaster } from "./Toaster";
import { ErrorBoundary } from "./ErrorBoundary";
import { ConnectionBanner } from "./ConnectionBanner";
import { RouteMap, loadSelectedRoute } from "./RouteMap";
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
  /** Initial cluster status (used in tests to skip SSE) */
  initialClusterStatus?: ClusterStatus;
  /** Optional pre-constructed controller instance (for testing) */
  clusterStatusController?: ClusterStatusController;
  /** When true, hide the dev-loop ConnectionBanner (tests / Storybook). */
  hideConnectionBanner?: boolean;
}

export function ControlPanel({
  appSrc = "/app/",
  clusterEventsUrl = "/studio/cluster/events",
  initialClusterStatus,
  clusterStatusController: controllerProp,
  hideConnectionBanner = false,
}: ControlPanelProps) {
  const [clusterStatus, setClusterStatus] = useState<ClusterStatus>(
    initialClusterStatus ?? "unknown",
  );

  const controllerRef = useRef<ClusterStatusController | null>(null);

  useEffect(() => {
    if (initialClusterStatus !== undefined) return;
    const ctrl =
      controllerProp ??
      new ClusterStatusController({ eventsUrl: clusterEventsUrl });
    controllerRef.current = ctrl;
    const unsub = ctrl.subscribe(setClusterStatus);
    ctrl.connect();
    return () => {
      unsub();
      if (!controllerProp) ctrl.dispose();
    };
  }, [clusterEventsUrl, initialClusterStatus]);

  useEffect(() => {
    if (initialClusterStatus !== undefined) {
      setClusterStatus(initialClusterStatus);
    }
  }, [initialClusterStatus]);

  const [activeTab, setActiveTab] = useState<
    "studio" | "viewport" | "product" | "debug"
  >("studio");

  const [viewport, setViewportState] = useState<Viewport>(() => loadViewport());
  const setViewport = (v: Viewport): void => {
    setViewportState(v);
    saveViewport(v);
  };

  const [iframeSrc, setIframeSrc] = useState<string>(() => {
    const stored = loadSelectedRoute();
    if (stored) {
      const tail = stored.startsWith("/") ? stored.slice(1) : stored;
      return `/app/${tail}`;
    }
    return appSrc;
  });

  useEffect(() => {
    debugStore.breadcrumb({
      category: "route",
      message: `tab: ${activeTab}`,
      data: { tab: activeTab },
    });
  }, [activeTab]);

  return (
    <div
      className="flex h-screen w-full flex-col overflow-hidden"
      style={{ background: "var(--bg-base)" }}
      data-testid="studio-panel"
    >
      {!hideConnectionBanner && <ConnectionBanner />}
      <div
        className="flex shrink-0"
        style={{
          background: "var(--bg-raised)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
        data-testid="tab-bar"
      >
        <NavTab
          testid="tab-studio"
          label="Studio"
          active={activeTab === "studio"}
          onClick={() => setActiveTab("studio")}
        />
        <div
          style={{
            width: "1px",
            margin: "6px 4px",
            background: "var(--border-subtle)",
            alignSelf: "stretch",
          }}
          aria-hidden="true"
        />
        <NavTab
          testid="tab-viewport"
          label="Viewport"
          active={activeTab === "viewport"}
          onClick={() => setActiveTab("viewport")}
        />
        <NavTab
          testid="tab-product"
          label="Product"
          active={activeTab === "product"}
          onClick={() => setActiveTab("product")}
        />
        <DebugBadge
          active={activeTab === "debug"}
          onClick={() => setActiveTab("debug")}
        />
      </div>

      {/* Studio tab — feature pane */}
      {activeTab === "studio" && (
        <ErrorBoundary label="Studio">
          <div className="flex flex-1 overflow-hidden">
            <FeaturePane />
          </div>
        </ErrorBoundary>
      )}

      {/* Viewport tab — route picker + resizable iframe */}
      {activeTab === "viewport" && (
        <ErrorBoundary label="Viewport">
          <div className="flex flex-1 overflow-hidden">
            <div className="hidden lg:flex">
              <RouteMap
                onSelect={(path) => {
                  const tail = path.startsWith("/") ? path.slice(1) : path;
                  setIframeSrc(`/app/${tail}`);
                }}
              />
            </div>
            <div className="flex-1 flex flex-col">
              <ViewportToolbar value={viewport} onChange={setViewport} />
              <IframePanel
                src={iframeSrc}
                clusterStatus={clusterStatus}
                iframeWidth={VIEWPORT_WIDTHS[viewport]}
              />
            </div>
          </div>
        </ErrorBoundary>
      )}

      {/* Product tab — docs viewer + product chat */}
      {activeTab === "product" && (
        <ErrorBoundary label="Product">
          <div className="flex flex-1 overflow-hidden">
            <ProductTab />
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

// ── NavTab ───────────────────────────────────────────────────────────────────

function NavTab({
  testid,
  label,
  active,
  onClick,
}: {
  testid: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={testid}
      data-nav-label="true"
      data-active={active ? "true" : "false"}
      onClick={onClick}
      style={{
        padding: "8px 16px",
        background: "transparent",
        border: "none",
        borderLeft: active
          ? "2px solid var(--accent-cyan)"
          : "2px solid transparent",
        borderBottom: active
          ? "1px solid var(--accent-cyan)"
          : "1px solid transparent",
        cursor: "pointer",
        transition: "color var(--duration-base) var(--ease-out)",
      }}
    >
      {label.toUpperCase()}
    </button>
  );
}
