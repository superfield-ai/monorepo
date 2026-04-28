/**
 * @file OrchestratorView
 *
 * Studio orchestrator panel — route /studio/orchestrator
 *
 * Sections:
 *   - Process status badge + Start/Stop buttons
 *   - Loop status bar: plan / dev / doc — last tick, circuit state
 *   - Active slots list: issue, role, backend, elapsed, heartbeat indicator
 *   - Log tail pane: last N lines, auto-scroll, SSE-streamed
 *
 * Visuals follow the Superfield Control Room design system: near-void
 * backgrounds, sharp corners, mono ALL-CAPS labels, status-coloured badges
 * sourced from the token sheet. Behaviour, event handlers and `data-testid`
 * values are preserved verbatim.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  OrchestratorController,
  type OrchestratorState,
  type ProcessState,
} from "../controllers/OrchestratorController";
import { TurnTimeline } from "./TurnTimeline";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function relativeTime(ts?: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  return `${formatMs(diff)} ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const STATE_BADGE_CLASS: Record<ProcessState, string> = {
  stopped: "badge badge-offline",
  starting: "badge badge-caution",
  running: "badge badge-nominal",
  stopping: "badge badge-caution",
};

function StateBadge({ state }: { state: ProcessState }) {
  return (
    <span
      data-testid="process-state-badge"
      data-pill="true"
      className={STATE_BADGE_CLASS[state]}
    >
      {state}
    </span>
  );
}

function LoopRow({
  name,
  health,
}: {
  name: string;
  health: OrchestratorState["loops"]["plan"];
}) {
  const cellStyle: React.CSSProperties = {
    padding: "var(--sp-2) var(--sp-4) var(--sp-2) 0",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    color: "var(--fg-1)",
    verticalAlign: "middle",
  };
  const mutedCell: React.CSSProperties = {
    ...cellStyle,
    color: "var(--fg-2)",
  };
  return (
    <tr style={{ borderTop: "1px solid var(--border-subtle)" }}>
      <td
        style={{
          ...cellStyle,
          color: "var(--fg-2)",
          letterSpacing: "var(--ls-wider)",
          textTransform: "uppercase",
        }}
      >
        {name}
      </td>
      <td style={cellStyle}>{relativeTime(health.lastTickAt)}</td>
      <td style={mutedCell}>
        {health.lastTickDurationMs != null
          ? formatMs(health.lastTickDurationMs)
          : "—"}
      </td>
      <td
        style={{
          ...mutedCell,
          fontStyle: "italic",
          fontSize: "var(--text-xs)",
        }}
      >
        {health.idleReason ?? ""}
      </td>
      <td style={{ ...cellStyle, paddingRight: 0 }}>
        <span
          className={`badge ${health.circuitTripped ? "badge-critical" : "badge-nominal"}`}
          data-pill="true"
        >
          {health.circuitTripped
            ? `tripped (${health.consecutiveFailures})`
            : "closed"}
        </span>
      </td>
    </tr>
  );
}

function SlotCard({ slot }: { slot: OrchestratorState["slots"][number] }) {
  const heartbeatAge = slot.heartbeatAt
    ? Date.now() - slot.heartbeatAt
    : Infinity;
  const heartbeatOk = heartbeatAge < 30_000;

  return (
    <div
      data-testid={`slot-card-${slot.slot}`}
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border-subtle)",
        padding: "var(--sp-3)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          className="value-lg"
          style={{ color: "var(--fg-1)" }}
        >{`#${slot.issueNumber}`}</span>
        <span
          data-pill="true"
          title={heartbeatOk ? "heartbeat ok" : "no recent heartbeat"}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: heartbeatOk
              ? "var(--status-nominal)"
              : "var(--status-offline)",
            boxShadow: heartbeatOk ? "var(--glow-green)" : "none",
            flexShrink: 0,
          }}
        />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: "var(--sp-1)",
          columnGap: "var(--sp-3)",
          alignItems: "baseline",
        }}
      >
        <span className="label">ROLE</span>
        <span className="value" style={{ fontSize: "var(--text-sm)" }}>
          {slot.role}
        </span>
        <span className="label">BACKEND</span>
        <span className="value" style={{ fontSize: "var(--text-sm)" }}>
          {slot.backend}
        </span>
        <span className="label">MODEL</span>
        <span
          className="value"
          style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
        >
          {slot.model}
        </span>
        <span className="label">ELAPSED</span>
        <span className="value-lg" style={{ fontSize: "var(--text-md)" }}>
          {formatMs(slot.elapsedMs)}
        </span>
      </div>
      {slot.sessionId ? <TurnTimeline sessionId={slot.sessionId} /> : null}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface OrchestratorViewProps {
  controller?: OrchestratorController;
  repo?: string;
  manageLifecycle?: boolean;
}

const SECTION_STYLE: React.CSSProperties = {
  background: "var(--bg-raised)",
  border: "1px solid var(--border-subtle)",
  padding: "var(--sp-3) var(--sp-4)",
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
  marginBottom: "var(--sp-2)",
  display: "block",
};

const PRIMARY_BTN: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
  padding: "var(--sp-1) var(--sp-3)",
  background: "transparent",
  color: "var(--accent-green)",
  border: "1px solid var(--accent-green)",
  cursor: "pointer",
  transition: "background var(--duration-fast) var(--ease-out)",
};

const DANGER_BTN: React.CSSProperties = {
  ...PRIMARY_BTN,
  color: "var(--accent-red)",
  border: "1px solid var(--accent-red)",
};

export function OrchestratorView({
  controller: controllerProp,
  repo = "",
  manageLifecycle = true,
}: OrchestratorViewProps) {
  const controllerRef = useRef<OrchestratorController>(
    controllerProp ?? new OrchestratorController(),
  );
  const [state, setState] = useState<OrchestratorState>(
    controllerRef.current.getState(),
  );
  const logEndRef = useRef<HTMLDivElement>(null);
  const [repoInput, setRepoInput] = useState(repo);

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setState);
    if (manageLifecycle) {
      ctrl.start();
    }
    return () => {
      unsub();
      if (manageLifecycle) {
        ctrl.stop();
      }
    };
  }, [manageLifecycle]);

  // Auto-scroll log pane.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.logs]);

  const canStart = state.processState === "stopped";
  const canStop =
    state.processState === "running" || state.processState === "starting";

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        flexDirection: "column",
        gap: "var(--sp-4)",
        overflow: "auto",
        padding: "var(--sp-4)",
        background: "var(--bg-base)",
      }}
    >
      {/* Process controls */}
      <section
        style={{
          ...SECTION_STYLE,
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          flexWrap: "wrap",
        }}
      >
        <StateBadge state={state.processState} />
        {state.pid && (
          <span className="label" style={{ color: "var(--fg-3)" }}>
            PID&nbsp;
            <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
              {state.pid}
            </span>
          </span>
        )}
        {state.uptimeMs > 0 && (
          <span className="label" style={{ color: "var(--fg-3)" }}>
            UP&nbsp;
            <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
              {formatMs(state.uptimeMs)}
            </span>
          </span>
        )}
        <span
          className="badge"
          data-pill="true"
          style={{
            marginLeft: "auto",
            color: state.apiReachable
              ? "var(--status-nominal)"
              : "var(--status-offline)",
            background: state.apiReachable
              ? "rgba(57, 217, 138, 0.06)"
              : "transparent",
          }}
        >
          API {state.apiReachable ? "reachable" : "unreachable"}
        </span>
        <input
          data-testid="repo-input"
          placeholder="/path/to/repo"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          style={{
            width: 220,
            padding: "var(--sp-1) var(--sp-2)",
            background: "var(--bg-base)",
            border: "1px solid var(--border-subtle)",
            color: "var(--fg-1)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            outline: "none",
          }}
        />
        <button
          data-testid="start-button"
          disabled={!canStart || !repoInput}
          onClick={() => controllerRef.current.startDevLoop(repoInput)}
          style={{
            ...PRIMARY_BTN,
            opacity: !canStart || !repoInput ? 0.4 : 1,
            cursor: !canStart || !repoInput ? "not-allowed" : "pointer",
          }}
        >
          START
        </button>
        <button
          data-testid="stop-button"
          disabled={!canStop}
          onClick={() => controllerRef.current.stopDevLoop()}
          style={{
            ...DANGER_BTN,
            opacity: !canStop ? 0.4 : 1,
            cursor: !canStop ? "not-allowed" : "pointer",
          }}
        >
          STOP
        </button>
        {state.error && (
          <span
            className="mono"
            style={{
              color: "var(--accent-red)",
              fontSize: "var(--text-xs)",
            }}
          >
            {state.error}
          </span>
        )}
      </section>

      {/* Loop status bar */}
      <section style={SECTION_STYLE}>
        <h2 className="label" style={SECTION_TITLE_STYLE}>
          LOOPS
        </h2>
        <table
          style={{ width: "100%", borderCollapse: "collapse" }}
          data-testid="loop-table"
        >
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th
                className="label"
                style={{ padding: "var(--sp-1) var(--sp-4) var(--sp-1) 0" }}
              >
                LOOP
              </th>
              <th
                className="label"
                style={{ padding: "var(--sp-1) var(--sp-4) var(--sp-1) 0" }}
              >
                LAST TICK
              </th>
              <th
                className="label"
                style={{ padding: "var(--sp-1) var(--sp-4) var(--sp-1) 0" }}
              >
                DURATION
              </th>
              <th
                className="label"
                style={{ padding: "var(--sp-1) var(--sp-4) var(--sp-1) 0" }}
              >
                IDLE REASON
              </th>
              <th className="label" style={{ padding: "var(--sp-1) 0" }}>
                CIRCUIT
              </th>
            </tr>
          </thead>
          <tbody>
            <LoopRow name="plan" health={state.loops.plan} />
            <LoopRow name="dev" health={state.loops.dev} />
            <LoopRow name="doc" health={state.loops.doc} />
          </tbody>
        </table>
      </section>

      {/* Active slots */}
      {state.slots.length > 0 && (
        <section style={SECTION_STYLE}>
          <h2 className="label" style={SECTION_TITLE_STYLE}>
            ACTIVE SLOTS ({state.slots.length})
          </h2>
          <div
            style={{
              display: "grid",
              gap: "var(--sp-2)",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            }}
          >
            {state.slots.map((slot) => (
              <SlotCard key={slot.slot} slot={slot} />
            ))}
          </div>
        </section>
      )}

      {/* Log tail */}
      <section
        data-testid="log-pane"
        style={{
          ...SECTION_STYLE,
          background: "var(--bg-void)",
          display: "flex",
          flex: 1,
          flexDirection: "column",
          padding: "var(--sp-3)",
        }}
      >
        <h2 className="label" style={SECTION_TITLE_STYLE}>
          Dev loop logs
        </h2>
        <div
          style={{
            flex: 1,
            overflow: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            lineHeight: "var(--lh-normal)",
            color: "var(--accent-green)",
          }}
        >
          {state.logs.map((line, i) => (
            <div key={i} style={{ whiteSpace: "pre" }}>
              {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </section>
    </div>
  );
}
