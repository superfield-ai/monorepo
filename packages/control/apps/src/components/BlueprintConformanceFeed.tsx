/**
 * @file BlueprintConformanceFeed
 *
 * Studio sub-view (C-9.7) — shows live blueprint conformance check results
 * as the agent runs.
 *
 * Each blueprint rule is shown with a colour-coded status badge:
 *   - pass     → green
 *   - fail     → red
 *   - advisory → yellow
 *
 * The feed polls GET /studio/conformance every 30 s and also exposes a
 * manual refresh button.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  BlueprintConformanceController,
  type BlueprintConformanceState,
  type ConformanceRule,
  type ConformanceStatus,
} from "../controllers/BlueprintConformanceController";

// ── Design tokens ─────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
};

const STATUS_COLORS: Record<ConformanceStatus, string> = {
  pass: "var(--accent-green)",
  fail: "var(--accent-red)",
  advisory: "var(--accent-yellow, #e5c07b)",
};

function statusColor(status: ConformanceStatus): string {
  return STATUS_COLORS[status] ?? "var(--fg-2)";
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ConformanceStatus }) {
  return (
    <span
      style={{
        ...LABEL,
        color: statusColor(status),
        border: `1px solid ${statusColor(status)}`,
        padding: "1px 6px",
        borderRadius: 2,
        display: "inline-block",
        minWidth: 68,
        textAlign: "center",
      }}
    >
      {status.toUpperCase()}
    </span>
  );
}

// ── Rule table ────────────────────────────────────────────────────────────────

function RuleTable({ state }: { state: BlueprintConformanceState }) {
  const { rules, loading, error } = state;

  if (loading && rules.length === 0) {
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

  if (error && rules.length === 0) {
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
        data-testid="conformance-error"
      >
        {error}
      </div>
    );
  }

  if (!loading && rules.length === 0) {
    return (
      <div
        style={{
          padding: "var(--sp-8)",
          textAlign: "center",
          ...LABEL,
          color: "var(--fg-3)",
        }}
        data-testid="conformance-empty"
      >
        NO CONFORMANCE RESULTS YET — RUN THE AGENT TO CHECK CONFORMANCE
      </div>
    );
  }

  return (
    <table
      data-testid="conformance-table"
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
              width: 88,
            }}
          >
            STATUS
          </th>
          <th
            style={{
              ...LABEL,
              color: "var(--fg-2)",
              textAlign: "left",
              padding: "var(--sp-2) var(--sp-3)",
              width: 120,
            }}
          >
            RULE ID
          </th>
          <th
            style={{
              ...LABEL,
              color: "var(--fg-2)",
              textAlign: "left",
              padding: "var(--sp-2) var(--sp-3)",
            }}
          >
            DETAILS
          </th>
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} />
        ))}
      </tbody>
    </table>
  );
}

function RuleRow({ rule }: { rule: ConformanceRule }) {
  return (
    <tr
      data-testid={`conformance-row-${rule.id}`}
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        background: "transparent",
      }}
    >
      <td style={{ padding: "var(--sp-2) var(--sp-3)" }}>
        <StatusBadge status={rule.status} />
      </td>
      <td
        style={{
          padding: "var(--sp-2) var(--sp-3)",
          color: "var(--fg-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
        }}
      >
        {rule.id}
      </td>
      <td
        style={{
          padding: "var(--sp-2) var(--sp-3)",
          color: "var(--fg-1)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
        }}
      >
        <span style={{ fontWeight: 600 }}>{rule.name}</span>
        {rule.detail && (
          <span style={{ color: "var(--fg-3)", marginLeft: "var(--sp-2)" }}>
            — {rule.detail}
          </span>
        )}
      </td>
    </tr>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

interface BlueprintConformanceFeedProps {
  controller?: BlueprintConformanceController;
}

export function BlueprintConformanceFeed({
  controller: controllerProp,
}: BlueprintConformanceFeedProps) {
  const controllerRef = useRef<BlueprintConformanceController>(
    controllerProp ?? new BlueprintConformanceController(),
  );
  const [state, setState] = useState<BlueprintConformanceState>(
    controllerRef.current.getState(),
  );

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setState);
    ctrl.start();
    return () => {
      unsub();
      ctrl.stop();
    };
  }, []);

  const ctrl = controllerRef.current;

  const lastUpdated =
    state.updatedAt !== null
      ? new Date(state.updatedAt).toLocaleTimeString()
      : null;

  return (
    <div
      data-testid="blueprint-conformance-feed"
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
          BLUEPRINT CONFORMANCE
        </span>
        {lastUpdated && (
          <span style={{ ...LABEL, color: "var(--fg-3)", fontSize: "10px" }}>
            UPDATED {lastUpdated}
          </span>
        )}
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
          data-testid="conformance-refresh"
          onClick={() => void ctrl.load()}
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
        <RuleTable state={state} />
      </div>
    </div>
  );
}
