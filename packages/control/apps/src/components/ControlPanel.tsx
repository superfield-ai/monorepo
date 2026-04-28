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
import { IssueRail, type DemoIssue } from "./IssueRail";
import { ComponentPreviewPanel } from "./ComponentPreviewPanel";
import type { ClusterStatus } from "./ClusterStatusIndicator";
import { ClusterStatusController } from "../controllers/ClusterStatusController";
import { OrchestratorController } from "../controllers/OrchestratorController";
import { DebugView } from "./DebugView";
import { DebugBadge } from "./DebugBadge";
import { Toaster } from "./Toaster";
import { ErrorBoundary } from "./ErrorBoundary";
import { ConnectionBanner } from "./ConnectionBanner";
import { DeployView } from "./DeployView";
import { RouteMap, loadSelectedRoute } from "./RouteMap";
import {
  ViewportToolbar,
  VIEWPORT_WIDTHS,
  loadViewport,
  saveViewport,
  type Viewport,
} from "./ViewportToolbar";
import { debugStore } from "../lib/debug-store";
import type { ChatMode, ChatSessionController } from "./ChatPanel";

interface ControlPanelProps {
  /** URL loaded in the app iframe; defaults to /app/ */
  appSrc?: string;
  /** SSE endpoint for cluster status events; defaults to /studio/cluster/events */
  clusterEventsUrl?: string;
  /** Optional pre-constructed chat controller instance (for testing). */
  chatController?: ChatSessionController;
  /** Initial cluster status (used in tests to skip SSE) */
  initialClusterStatus?: ClusterStatus;
  /** Optional pre-constructed controller instance (for testing) */
  clusterStatusController?: ClusterStatusController;
  /** Optional demo issue payloads; when omitted the rail fetches /studio/demo/issues. */
  demoIssues?: DemoIssue[];
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
  chatController,
  initialClusterStatus,
  clusterStatusController: controllerProp,
  demoIssues: demoIssuesProp,
  hideConnectionBanner = false,
}: ControlPanelProps) {
  const [clusterStatus, setClusterStatus] = useState<ClusterStatus>(
    initialClusterStatus ?? "unknown",
  );

  const controllerRef = useRef<ClusterStatusController | null>(null);
  const orchestratorControllerRef = useRef(new OrchestratorController());
  const [orchestratorState, setOrchestratorState] = useState(
    null as ReturnType<OrchestratorController["getState"]> | null,
  );
  const [demoIssues, setDemoIssues] = useState<DemoIssue[]>(
    demoIssuesProp ?? [],
  );
  const [chatMode, setChatMode] = useState<ChatMode>("feature");
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(
    null,
  );

  useEffect(() => {
    if (demoIssuesProp !== undefined) {
      setDemoIssues(demoIssuesProp);
      return;
    }
    let cancelled = false;
    void fetch("/studio/demo/issues")
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        const issues = Array.isArray(body?.issues) ? (body.issues as DemoIssue[]) : [];
        setDemoIssues(issues);
      })
      .catch(() => {
        if (!cancelled) setDemoIssues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [demoIssuesProp]);

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

  useEffect(() => {
    const ctrl = orchestratorControllerRef.current;
    const unsub = ctrl.subscribe(setOrchestratorState);
    ctrl.start();
    return () => {
      unsub();
      ctrl.stop();
    };
  }, []);

  // Sync override changes after initial render
  useEffect(() => {
    if (initialClusterStatus !== undefined) {
      setClusterStatus(initialClusterStatus);
    }
  }, [initialClusterStatus]);

  const [activeTab, setActiveTab] = useState<
    "studio" | "orchestrator" | "workshop" | "deploy" | "debug"
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
      className="flex h-screen w-full flex-col overflow-hidden"
      style={{ background: "var(--bg-base)" }}
      data-testid="studio-panel"
    >
      {!hideConnectionBanner && <ConnectionBanner />}
      {/* Tab bar — operator-grade: ALL CAPS mono with widest tracking,
          left-border accent on active per the design system. */}
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
        {/* Visual separator between primary (Studio) and operational tabs */}
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
          testid="tab-orchestrator"
          label="Background Agent"
          active={activeTab === "orchestrator"}
          onClick={() => setActiveTab("orchestrator")}
        />
        <NavTab
          testid="tab-preview"
          label="Workshop"
          active={activeTab === "workshop"}
          onClick={() => setActiveTab("workshop")}
        />
        <NavTab
          testid="tab-deploy"
          label="Deploy"
          active={activeTab === "deploy"}
          onClick={() => setActiveTab("deploy")}
        />
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
                clusterEventsUrl={clusterEventsUrl}
                controller={chatController}
                mode={chatMode}
                selectedIssue={
                  demoIssues.find((issue) => issue.number === selectedIssueNumber) ??
                  null
                }
                onModeChange={(nextMode) => {
                  if (nextMode === "steer") {
                    const issue = demoIssues.find(
                      (candidate) => candidate.number === selectedIssueNumber,
                    );
                    if (!issue?.sessionId) return;
                  }
                  setChatMode(nextMode);
                }}
              />
            </div>
            <div className="hidden xl:flex w-96 shrink-0">
              <IssueRail
                issues={demoIssues}
                slots={orchestratorState?.slots ?? []}
                selectedIssueNumber={selectedIssueNumber}
                onSelectIssue={(issue) => {
                  setSelectedIssueNumber(issue.number);
                  if (issue.sessionId) {
                    setChatMode("steer");
                  }
                }}
              />
            </div>
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

      {/* Orchestrator tab */}
      {activeTab === "orchestrator" && (
        <ErrorBoundary label="Orchestrator">
          <div className="flex-1 overflow-hidden bg-gray-50">
            <OrchestratorView
              controller={orchestratorControllerRef.current}
              manageLifecycle={false}
            />
          </div>
        </ErrorBoundary>
      )}

      {/* Workshop tab */}
      {activeTab === "workshop" && (
        <ErrorBoundary label="Workshop">
          <div className="flex-1 overflow-hidden bg-white flex flex-col">
            <div
              style={{
                padding: "var(--sp-2) var(--sp-4)",
                borderBottom: "1px solid var(--border-subtle)",
                background: "var(--bg-raised)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
                letterSpacing: "var(--ls-wider)",
              }}
            >
              Render individual components with fixture data — no running app
              required.
            </div>
            <div className="flex-1 overflow-hidden">
              <ComponentPreviewPanel />
            </div>
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

// ── NavTab ───────────────────────────────────────────────────────────────────
// Operator-grade tab button. ALL CAPS mono label with widest tracking. Active
// state shows a 2px cyan left-accent border and brightens the label to fg-1.
// Sharp corners — no rounding. (Per docs/colors_and_type.css and the
// MissionCtrl design system spec.)

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
