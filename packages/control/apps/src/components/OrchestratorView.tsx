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
 *   - C-11.3: CI status feed — live check-run events for the target repo (SSE)
 *   - C-11.4: One-click escalate button on failed check-run rows
 *
 * Visuals follow the Superfield Control Room design system: near-void
 * backgrounds, sharp corners, mono ALL-CAPS labels, status-coloured badges
 * sourced from the token sheet. Behaviour, event handlers and `data-testid`
 * values are preserved verbatim.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  OrchestratorController,
  type HeartbeatEntry,
  type OrchestratorState,
  type ProcessState,
} from "../controllers/OrchestratorController";
import { TurnTimeline } from "./TurnTimeline";
import { openEventSource } from "../lib/net";
import { fetchJson } from "../lib/net";
import type { CheckRun } from "../lib/check-runs";

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

/** State-colour map for heartbeat timeline dots. */
const HEARTBEAT_STATE_COLOR: Record<HeartbeatEntry["state"], string> = {
  idle: "var(--fg-3)",
  running: "var(--status-nominal)",
  done: "var(--accent-green)",
};

/**
 * SlotHeartbeatHistory renders a mini horizontal timeline of the last N slot
 * state transitions (idle → running → done).
 */
function SlotHeartbeatHistory({
  history,
  slotKey,
}: {
  history: HeartbeatEntry[];
  slotKey: string;
}): JSX.Element | null {
  if (history.length === 0) return null;
  return (
    <div
      data-testid={`slot-heartbeat-history-${slotKey}`}
      style={{
        marginTop: "var(--sp-1)",
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-1)",
        flexWrap: "wrap",
      }}
    >
      <span
        className="label"
        style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
      >
        HB
      </span>
      {history.map((entry, idx) => (
        <span
          key={`${entry.at}-${idx}`}
          title={`${entry.state} @ ${new Date(entry.at).toISOString().slice(11, 19)}`}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: HEARTBEAT_STATE_COLOR[entry.state],
            flexShrink: 0,
            display: "inline-block",
          }}
        />
      ))}
    </div>
  );
}

function SlotCard({
  slot,
  heartbeatHistory,
}: {
  slot: OrchestratorState["slots"][number];
  heartbeatHistory: HeartbeatEntry[];
}) {
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
      <SlotHeartbeatHistory
        history={heartbeatHistory}
        slotKey={String(slot.slot)}
      />
    </div>
  );
}

// ── C-11.3/11.4: CiStatusFeed ────────────────────────────────────────────────

const MAX_CI_ROWS = 50;

/** Shape of one event pushed by the SSE stream at /analytics/check-runs/stream. */
interface CiStreamEvent {
  readonly sha: string;
  readonly checkRun: CheckRun;
  readonly ts: number;
}

/** Unique key for a CiRow — sha + check name. */
function ciRowKey(sha: string, name: string): string {
  return `${sha}:${name}`;
}

interface CiRow {
  readonly key: string;
  readonly sha: string;
  readonly checkRun: CheckRun;
  readonly ts: number;
}

interface EscalateResult {
  readonly ok: boolean;
  readonly issueUrl?: string;
  readonly error?: string;
}

/**
 * CiStatusFeed — C-11.3
 *
 * Subscribes to `GET /analytics/check-runs/stream` via SSE and renders a live
 * table of check-run events. Capped at MAX_CI_ROWS (50) entries; older rows
 * are pruned automatically. Auto-scrolls to new events.
 *
 * C-11.4: Each failed check-run row has a one-click "ESCALATE" button that
 * calls `POST /steer/escalate` with `{ sha, checkRunName }` to open a
 * ci-failure issue. On success it navigates to the new GitHub issue URL.
 *
 * @param repo - The target repo slug (owner/name) passed down from OrchestratorView.
 * @param ciRowsOverride - Static rows for tests / Storybook (skips SSE connection).
 */
export function CiStatusFeed({
  repo,
  ciRowsOverride,
}: {
  readonly repo: string;
  readonly ciRowsOverride?: readonly CiRow[];
}): JSX.Element {
  const [rows, setRows] = useState<readonly CiRow[]>(ciRowsOverride ?? []);
  const [escalating, setEscalating] = useState<string | null>(null);
  const [escalateError, setEscalateError] = useState<string | null>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ciRowsOverride !== undefined) {
      setRows(ciRowsOverride);
      return;
    }
    const handle = openEventSource({
      url: "/analytics/check-runs/stream",
      onMessage: (ev) => {
        try {
          const data = JSON.parse(ev.data as string) as CiStreamEvent;
          setRows((prev) => {
            const key = ciRowKey(data.sha, data.checkRun.name);
            // Update existing row or append new one.
            const existing = prev.findIndex((r) => r.key === key);
            let next: readonly CiRow[];
            if (existing >= 0) {
              next = [
                ...prev.slice(0, existing),
                { key, sha: data.sha, checkRun: data.checkRun, ts: data.ts },
                ...prev.slice(existing + 1),
              ];
            } else {
              next = [
                ...prev,
                { key, sha: data.sha, checkRun: data.checkRun, ts: data.ts },
              ];
            }
            // Prune oldest rows beyond the cap.
            return next.length > MAX_CI_ROWS
              ? next.slice(next.length - MAX_CI_ROWS)
              : next;
          });
        } catch {
          // Ignore malformed SSE payloads.
        }
      },
    });
    return () => handle.close();
  }, [ciRowsOverride, repo]);

  // Auto-scroll to newest row.
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows]);

  async function handleEscalate(row: CiRow): Promise<void> {
    const key = row.key;
    setEscalating(key);
    setEscalateError(null);
    const result = await fetchJson<EscalateResult>("/steer/escalate", {
      method: "POST",
      body: { sha: row.sha, checkRunName: row.checkRun.name, repo },
    });
    setEscalating(null);
    if (result.ok && result.value.issueUrl) {
      window.open(result.value.issueUrl, "_blank", "noopener");
    } else {
      setEscalateError(
        result.ok
          ? (result.value.error ?? "Escalation failed")
          : result.error.message,
      );
    }
  }

  if (rows.length === 0) {
    return (
      <div
        data-testid="ci-status-feed-empty"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--fg-3)",
          letterSpacing: "var(--ls-wider)",
          textTransform: "uppercase",
          padding: "var(--sp-2) 0",
        }}
      >
        AWAITING CHECK-RUN EVENTS…
      </div>
    );
  }

  return (
    <div data-testid="ci-status-feed" style={{ overflow: "auto", maxHeight: 320 }}>
      {escalateError && (
        <div
          style={{
            color: "var(--accent-red, #e06c75)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            marginBottom: "var(--sp-1)",
          }}
        >
          ESCALATE ERROR: {escalateError}
        </div>
      )}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
        }}
      >
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th className="label" style={{ padding: "var(--sp-1) var(--sp-2) var(--sp-1) 0" }}>
              CHECK
            </th>
            <th className="label" style={{ padding: "var(--sp-1) var(--sp-2) var(--sp-1) 0" }}>
              SHA
            </th>
            <th className="label" style={{ padding: "var(--sp-1) var(--sp-2) var(--sp-1) 0" }}>
              STATUS
            </th>
            <th className="label" style={{ padding: "var(--sp-1) 0" }}>
              ACTION
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const failed =
              row.checkRun.conclusion === "failure" ||
              row.checkRun.conclusion === "timed_out";
            const statusColor = failed
              ? "var(--accent-red, #e06c75)"
              : row.checkRun.status !== "completed"
                ? "var(--accent-amber, #e5c07b)"
                : "var(--accent-green, #39d98a)";
            const isEscalating = escalating === row.key;

            return (
              <tr
                key={row.key}
                data-testid={`ci-row-${row.key}`}
                style={{ borderTop: "1px solid var(--border-subtle)" }}
              >
                <td
                  style={{
                    padding: "var(--sp-1) var(--sp-2) var(--sp-1) 0",
                    color: "var(--fg-1)",
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.checkRun.name}
                </td>
                <td
                  style={{
                    padding: "var(--sp-1) var(--sp-2) var(--sp-1) 0",
                    color: "var(--fg-3)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {row.sha.slice(0, 7)}
                </td>
                <td
                  style={{
                    padding: "var(--sp-1) var(--sp-2) var(--sp-1) 0",
                    color: statusColor,
                    letterSpacing: "var(--ls-wider)",
                    textTransform: "uppercase",
                  }}
                >
                  {row.checkRun.conclusion ?? row.checkRun.status}
                </td>
                <td style={{ padding: "var(--sp-1) 0" }}>
                  {/* C-11.4: One-click escalate button on failed rows */}
                  {failed && (
                    <button
                      type="button"
                      data-testid={`escalate-btn-${row.key}`}
                      disabled={isEscalating}
                      onClick={() => void handleEscalate(row)}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                        letterSpacing: "var(--ls-wider)",
                        textTransform: "uppercase",
                        padding: "1px var(--sp-2)",
                        background: "transparent",
                        color: isEscalating
                          ? "var(--fg-3)"
                          : "var(--accent-red, #e06c75)",
                        border: `1px solid ${isEscalating ? "var(--fg-3)" : "var(--accent-red, #e06c75)"}`,
                        cursor: isEscalating ? "wait" : "pointer",
                        opacity: isEscalating ? 0.6 : 1,
                      }}
                    >
                      {isEscalating ? "ESCALATING…" : "ESCALATE"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div ref={feedEndRef} />
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
  const [logFilter, setLogFilter] = useState("");

  /** Logs filtered by the current keyword / level query (case-insensitive). */
  const filteredLogs = useMemo(() => {
    const trimmed = logFilter.trim();
    if (!trimmed) return state.logs;
    const lower = trimmed.toLowerCase();
    return state.logs.filter((line) => line.toLowerCase().includes(lower));
  }, [state.logs, logFilter]);

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
              <SlotCard
                key={slot.slot}
                slot={slot}
                heartbeatHistory={
                  state.heartbeatHistory[String(slot.slot)] ?? []
                }
              />
            ))}
          </div>
        </section>
      )}

      {/* C-11.3: CI status feed — live check-run events */}
      <section style={SECTION_STYLE} data-testid="ci-status-feed-section">
        <h2 className="label" style={SECTION_TITLE_STYLE}>
          CI STATUS
        </h2>
        <CiStatusFeed repo={repoInput} />
      </section>

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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--sp-2)",
            gap: "var(--sp-3)",
            flexWrap: "wrap",
          }}
        >
          <h2 className="label" style={{ margin: 0 }}>
            Dev loop logs
          </h2>
          <input
            data-testid="log-filter-input"
            type="search"
            placeholder="filter logs…"
            value={logFilter}
            onChange={(e) => setLogFilter(e.target.value)}
            aria-label="Filter log lines"
            style={{
              padding: "var(--sp-1) var(--sp-2)",
              background: "var(--bg-base)",
              border: "1px solid var(--border-subtle)",
              color: "var(--fg-1)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              outline: "none",
              minWidth: 160,
            }}
          />
          {logFilter && (
            <span
              className="label"
              style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}
            >
              {filteredLogs.length}/{state.logs.length}
            </span>
          )}
        </div>
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
          {filteredLogs.map((line, i) => (
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
