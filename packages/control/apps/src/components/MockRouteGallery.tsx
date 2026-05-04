/**
 * @file MockRouteGallery
 *
 * Studio sub-view (C-9.3) — lists all registered MSW / mock routes and
 * allows toggling each one on or off.
 *
 * Layout: full-height scrollable table with a sticky header toolbar.
 * Columns: Method badge | Path | Enabled toggle.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  MockRouteController,
  type MockRouteState,
  type MockRoute,
} from "../controllers/MockRouteController";

// ── Design tokens ─────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
};

const METHOD_COLORS: Record<string, string> = {
  GET: "var(--accent-cyan)",
  POST: "var(--accent-green)",
  PUT: "var(--accent-yellow, #e5c07b)",
  PATCH: "var(--accent-yellow, #e5c07b)",
  DELETE: "var(--accent-red)",
};

function methodColor(method: string): string {
  return METHOD_COLORS[method.toUpperCase()] ?? "var(--fg-2)";
}

// ── Method badge ──────────────────────────────────────────────────────────────

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      style={{
        ...LABEL,
        color: methodColor(method),
        border: `1px solid ${methodColor(method)}`,
        padding: "1px 6px",
        borderRadius: 2,
        display: "inline-block",
        minWidth: 52,
        textAlign: "center",
      }}
    >
      {method.toUpperCase()}
    </span>
  );
}

// ── Toggle button ─────────────────────────────────────────────────────────────

function ToggleButton({
  route,
  busy,
  onToggle,
}: {
  route: MockRoute;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`toggle-${route.id}`}
      onClick={onToggle}
      disabled={busy}
      style={{
        ...LABEL,
        padding: "2px 10px",
        background: "transparent",
        border: `1px solid ${route.enabled ? "var(--accent-cyan)" : "var(--border-subtle)"}`,
        color: route.enabled ? "var(--accent-cyan)" : "var(--fg-3)",
        cursor: busy ? "not-allowed" : "pointer",
        opacity: busy ? 0.5 : 1,
        transition:
          "border-color var(--duration-fast), color var(--duration-fast)",
      }}
    >
      {busy ? "..." : route.enabled ? "ON" : "OFF"}
    </button>
  );
}

// ── Route table ───────────────────────────────────────────────────────────────

function RouteTable({
  state,
  onToggle,
}: {
  state: MockRouteState;
  onToggle: (id: string) => void;
}) {
  const { routes, loading, error } = state;

  if (loading && routes.length === 0) {
    return (
      <div
        style={{
          padding: "var(--sp-8)",
          textAlign: "center",
          ...LABEL,
          color: "var(--fg-3)",
        }}
      >
        LOADING...
      </div>
    );
  }

  if (error && routes.length === 0) {
    return (
      <div
        style={{
          margin: "var(--sp-4)",
          padding: "var(--sp-3)",
          border: "1px solid var(--accent-red)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--accent-red)",
        }}
        data-testid="mock-route-error"
      >
        {error}
      </div>
    );
  }

  if (!loading && routes.length === 0) {
    return (
      <div
        style={{
          padding: "var(--sp-8)",
          textAlign: "center",
          ...LABEL,
          color: "var(--fg-3)",
        }}
        data-testid="mock-route-empty"
      >
        NO MOCK ROUTES REGISTERED
      </div>
    );
  }

  return (
    <table
      data-testid="mock-route-table"
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      }}
    >
      <thead>
        <tr
          style={{
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-raised)",
          }}
        >
          <th
            style={{
              ...LABEL,
              color: "var(--fg-2)",
              textAlign: "left",
              padding: "var(--sp-2) var(--sp-3)",
              width: 80,
            }}
          >
            METHOD
          </th>
          <th
            style={{
              ...LABEL,
              color: "var(--fg-2)",
              textAlign: "left",
              padding: "var(--sp-2) var(--sp-3)",
            }}
          >
            PATH
          </th>
          <th
            style={{
              ...LABEL,
              color: "var(--fg-2)",
              textAlign: "right",
              padding: "var(--sp-2) var(--sp-3)",
              width: 80,
            }}
          >
            STATUS
          </th>
        </tr>
      </thead>
      <tbody>
        {routes.map((route) => (
          <tr
            key={route.id}
            data-testid={`mock-route-row-${route.id}`}
            style={{
              borderBottom: "1px solid var(--border-subtle)",
              background: "transparent",
              opacity: route.enabled ? 1 : 0.55,
              transition: "opacity var(--duration-fast)",
            }}
          >
            <td style={{ padding: "var(--sp-2) var(--sp-3)" }}>
              <MethodBadge method={route.method} />
            </td>
            <td
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                color: "var(--fg-1)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
              }}
            >
              {route.path}
            </td>
            <td
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                textAlign: "right",
              }}
            >
              <ToggleButton
                route={route}
                busy={state.toggling.has(route.id)}
                onToggle={() => onToggle(route.id)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

interface MockRouteGalleryProps {
  controller?: MockRouteController;
}

export function MockRouteGallery({
  controller: controllerProp,
}: MockRouteGalleryProps) {
  const controllerRef = useRef<MockRouteController>(
    controllerProp ?? new MockRouteController(),
  );
  const [state, setState] = useState<MockRouteState>(
    controllerRef.current.getState(),
  );

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setState);
    void ctrl.loadRoutes();
    return unsub;
  }, []);

  const ctrl = controllerRef.current;

  return (
    <div
      data-testid="mock-route-gallery"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-base)",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: "var(--sp-2) var(--sp-4)",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-raised)",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          flexShrink: 0,
        }}
      >
        <span style={{ ...LABEL, color: "var(--fg-1)", flex: 1 }}>
          MOCK ROUTES
        </span>
        {state.loading && (
          <span style={{ ...LABEL, color: "var(--fg-3)" }}>↻</span>
        )}
        {state.error && !state.loading && (
          <span
            style={{ ...LABEL, color: "var(--accent-red)", fontSize: "10px" }}
          >
            ERROR
          </span>
        )}
        <button
          type="button"
          data-testid="mock-route-refresh"
          onClick={() => void ctrl.loadRoutes()}
          disabled={state.loading}
          style={{
            ...LABEL,
            padding: "2px 10px",
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            color: "var(--fg-2)",
            cursor: state.loading ? "not-allowed" : "pointer",
            opacity: state.loading ? 0.5 : 1,
          }}
        >
          REFRESH
        </button>
      </div>

      {/* Scrollable table area */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        <RouteTable
          state={state}
          onToggle={(id) => void ctrl.toggleRoute(id)}
        />
      </div>
    </div>
  );
}
