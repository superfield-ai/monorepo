/**
 * @file TurnTimeline.tsx
 *
 * Per-session turn timeline + prompt inspector (D6 / C-9.6). Used inside the
 * OrchestratorView slot cards.
 *
 *   <TurnTimeline sessionId="…" />
 *
 * Fetches /studio/turns/:sessionId. Each turn renders as a compact row with
 * timestamp, duration, and a one-line excerpt of the prompt. Click a row →
 * opens a modal with the full prompt body, response, a tool-call summary
 * (currently the file/service lists from the seed JSONL), and a before/after
 * visual diff (issue #250).
 *
 * C-11.1: Each turn row shows a CheckRunBadge sourced from
 *   GET /analytics/check-runs?sha=<commitSha>
 * Clicking the badge expands the inline test-output pane (C-11.2).
 *
 * Canonical docs: docs/studio-e2e-infrastructure.md — "Per-turn screenshot capture"
 */

import React, { useEffect, useState } from "react";
import { fetchJson } from "../lib/net";
import type { AppError } from "../lib/errors";
import type {
  CheckRun,
  CheckRunStatus,
  CheckRunsResponse,
} from "../lib/check-runs";
import { aggregateCheckRunStatus } from "../lib/check-runs";
import { EmptyState } from "./EmptyState";
import { InlineError } from "./InlineError";
import { TurnSparkline } from "./TurnSparkline";
import { VisualDiffPanel, TestOutputPane } from "./VisualDiffPanel";

export interface TurnSummary {
  readonly ts: string;
  readonly durationMs: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly exitStatus: string;
  readonly prompt: string;
  readonly response: string;
  readonly filesChanged?: readonly string[];
  readonly servicesRestarted?: readonly string[];
  /**
   * 1-based index of this turn within the session.
   * Used to derive before/after screenshot indices for the visual diff panel.
   * When absent (e.g. older turn data) the diff panel is not shown.
   */
  readonly turnIndex?: number;
  /**
   * Commit SHA associated with this turn's output (C-11.1).
   * When present, enables fetching check-run results for the per-turn badge.
   */
  readonly commitSha?: string;
  /**
   * Pull-request number associated with this turn (C-11.1).
   * Carried alongside commitSha for future drill-down links.
   */
  readonly prNumber?: number;
}

// ── C-11.1: CheckRunBadge ─────────────────────────────────────────────────────

// Re-export shared check-run types for consumers (e.g. tests/Storybook).
export type { CheckRun, CheckRunStatus };

const CHECK_RUN_BADGE_COLORS: Record<CheckRunStatus, string> = {
  pass: "var(--accent-green, #39d98a)",
  fail: "var(--accent-red, #e06c75)",
  running: "var(--accent-amber, #e5c07b)",
  unknown: "var(--fg-3)",
};

/**
 * CheckRunBadge — fetches check-run results for a given commit SHA and renders
 * a compact pass/fail/running/unknown indicator on each TurnTimeline row.
 * Clicking the badge toggles the inline TestOutputPane (C-11.2).
 *
 * @param commitSha - The commit SHA to look up check-run results for.
 * @param onTogglePane - Called when the badge is clicked to toggle the test output pane.
 * @param paneOpen - Whether the test output pane is currently expanded.
 * @param checkRunsOverride - Override for tests / Storybook (skips fetch).
 */
export function CheckRunBadge({
  commitSha,
  onTogglePane,
  paneOpen,
  checkRunsOverride,
}: {
  readonly commitSha: string;
  readonly onTogglePane: () => void;
  readonly paneOpen: boolean;
  readonly checkRunsOverride?: readonly CheckRun[];
}): JSX.Element {
  const [runs, setRuns] = useState<readonly CheckRun[]>(
    checkRunsOverride ?? [],
  );
  const [loading, setLoading] = useState(checkRunsOverride === undefined);

  useEffect(() => {
    if (checkRunsOverride !== undefined) {
      setRuns(checkRunsOverride);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const result = await fetchJson<CheckRunsResponse>(
        `/analytics/check-runs?sha=${encodeURIComponent(commitSha)}`,
      );
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setRuns(result.value.checkRuns);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commitSha, checkRunsOverride]);

  const status: CheckRunStatus = loading
    ? "running"
    : aggregateCheckRunStatus(runs);
  const color = CHECK_RUN_BADGE_COLORS[status];
  const label = loading ? "…" : status.toUpperCase();

  return (
    <button
      type="button"
      data-testid={`check-run-badge-${commitSha}`}
      onClick={(e) => {
        e.stopPropagation();
        onTogglePane();
      }}
      title={`CI: ${status}${paneOpen ? " — click to collapse" : " — click to expand"}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px var(--sp-1)",
        border: `1px solid ${color}`,
        background: "transparent",
        color,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "var(--ls-wider)",
        textTransform: "uppercase",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
          display: "inline-block",
        }}
      />
      {label}
      {runs.length > 0 && <span style={{ opacity: 0.7 }}>({runs.length})</span>}
    </button>
  );
}

interface TurnsResponse {
  readonly sessionId: string;
  readonly turns: readonly TurnSummary[];
}

interface TurnTimelineProps {
  readonly sessionId: string;
  /** Optional pre-loaded turns (for tests). */
  readonly turnsOverride?: readonly TurnSummary[];
}

export function TurnTimeline({
  sessionId,
  turnsOverride,
}: TurnTimelineProps): JSX.Element {
  const [turns, setTurns] = useState<readonly TurnSummary[]>(
    turnsOverride ?? [],
  );
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(turnsOverride === undefined);
  const [active, setActive] = useState<TurnSummary | null>(null);
  /** Track which turn rows have the test-output pane expanded (by turn index). */
  const [expandedPane, setExpandedPane] = useState<number | null>(null);

  useEffect(() => {
    if (turnsOverride !== undefined) {
      setTurns(turnsOverride);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const result = await fetchJson<TurnsResponse>(
        `/studio/turns/${encodeURIComponent(sessionId)}`,
      );
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setTurns(result.value.turns);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, turnsOverride]);

  if (error) {
    return (
      <div data-testid={`turn-timeline-${sessionId}`}>
        <InlineError
          title="RESOURCE FAULT — TURN TIMELINE"
          error={error}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  if (!loading && turns.length === 0) {
    return (
      <div
        data-testid={`turn-timeline-${sessionId}`}
        style={{ marginTop: "var(--sp-2)" }}
      >
        <EmptyState
          title="NO TURNS RECORDED"
          hint="The agent has not produced any turns for this session."
          testId={`timeline-${sessionId}`}
        />
      </div>
    );
  }

  return (
    <div
      data-testid={`turn-timeline-${sessionId}`}
      style={{ marginTop: "var(--sp-2)" }}
    >
      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-1)",
        }}
      >
        {turns.map((turn, idx) => (
          <li key={`${turn.ts}-${idx}`}>
            <button
              type="button"
              data-testid={`turn-row-${sessionId}-${idx}`}
              onClick={() => setActive(turn)}
              style={{
                width: "100%",
                background: "var(--bg-raised)",
                border: "1px solid var(--border-subtle)",
                padding: "var(--sp-1) var(--sp-2)",
                textAlign: "left",
                fontSize: "var(--text-xs)",
                color: "var(--fg-1)",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-3)",
                  letterSpacing: "var(--ls-wider)",
                  textTransform: "uppercase",
                }}
              >
                <span>{formatTs(turn.ts)}</span>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--sp-2)",
                  }}
                >
                  {/* C-11.1: per-turn check-run badge */}
                  {turn.commitSha && (
                    <CheckRunBadge
                      commitSha={turn.commitSha}
                      paneOpen={expandedPane === idx}
                      onTogglePane={() =>
                        setExpandedPane((prev) => (prev === idx ? null : idx))
                      }
                    />
                  )}
                  <span>{formatDuration(turn.durationMs)}</span>
                </div>
              </div>
              <div
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--fg-1)",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {turn.prompt || "(no prompt)"}
              </div>
            </button>
            {/* C-11.2: inline test-output pane, expanded when badge is clicked */}
            {turn.commitSha && expandedPane === idx && (
              <TestOutputPane
                commitSha={turn.commitSha}
                defaultExpanded={true}
              />
            )}
          </li>
        ))}
      </ol>
      {active ? (
        <TurnModal
          turn={active}
          sessionId={sessionId}
          onClose={() => setActive(null)}
        />
      ) : null}
      {turns.length > 0 && (
        <div
          style={{
            marginTop: "var(--sp-2)",
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
          }}
        >
          <span
            className="label"
            style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
          >
            COST / TURN
          </span>
          <TurnSparkline turns={turns} width={120} height={28} />
        </div>
      )}
    </div>
  );
}

function formatTs(ts: string): string {
  if (!ts) return "—";
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toISOString().slice(11, 19);
}

function formatDuration(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function TurnModal({
  turn,
  sessionId,
  onClose,
}: {
  readonly turn: TurnSummary;
  readonly sessionId: string;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="turn-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
        padding: "var(--sp-4)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxHeight: "80vh",
          width: "100%",
          maxWidth: 768,
          overflowY: "auto",
          background: "var(--bg-raised)",
          border: "1px solid var(--border-default)",
          padding: "var(--sp-4)",
          fontSize: "var(--text-sm)",
          color: "var(--fg-1)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h3 className="h2" style={{ margin: 0 }}>
            TURN DETAIL
          </h3>
          <button
            type="button"
            data-testid="turn-modal-close"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--border-default)",
              color: "var(--fg-1)",
              padding: "var(--sp-1) var(--sp-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              letterSpacing: "var(--ls-wider)",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            CLOSE
          </button>
        </div>
        <dl
          style={{
            marginTop: "var(--sp-3)",
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            columnGap: "var(--sp-4)",
            rowGap: "var(--sp-1)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "var(--ls-wider)",
            textTransform: "uppercase",
          }}
        >
          <dt>TIMESTAMP</dt>
          <dd style={{ color: "var(--fg-1)", margin: 0 }}>{turn.ts}</dd>
          <dt>DURATION</dt>
          <dd style={{ color: "var(--fg-1)", margin: 0 }}>
            {formatDuration(turn.durationMs)}
          </dd>
          <dt>EXIT</dt>
          <dd style={{ color: "var(--fg-1)", margin: 0 }}>{turn.exitStatus}</dd>
          <dt>TOKENS</dt>
          <dd style={{ color: "var(--fg-1)", margin: 0 }}>
            {turn.tokens || "—"}
          </dd>
        </dl>

        <Section title="PROMPT" body={turn.prompt} />
        <Section title="RESPONSE" body={turn.response} />

        {turn.turnIndex !== undefined ? (
          <div style={{ marginTop: "var(--sp-3)" }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                letterSpacing: "var(--ls-wider)",
                textTransform: "uppercase",
                color: "var(--fg-3)",
                marginBottom: "var(--sp-1)",
              }}
            >
              VISUAL DIFF
            </div>
            <VisualDiffPanel
              sessionId={sessionId}
              beforeTurn={turn.turnIndex - 1}
              afterTurn={turn.turnIndex}
            />
          </div>
        ) : null}

        {(turn.filesChanged?.length ?? 0) > 0 ||
        (turn.servicesRestarted?.length ?? 0) > 0 ? (
          <div
            style={{
              marginTop: "var(--sp-3)",
              border: "1px solid var(--border-subtle)",
              padding: "var(--sp-2)",
              fontSize: "var(--text-xs)",
            }}
          >
            <div className="label" style={{ marginBottom: "var(--sp-1)" }}>
              TOOL-CALL SUMMARY
            </div>
            {turn.filesChanged?.length ? (
              <div>
                <span style={{ color: "var(--fg-3)" }}>files: </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--fg-1)",
                  }}
                >
                  {turn.filesChanged.join(", ")}
                </span>
              </div>
            ) : null}
            {turn.servicesRestarted?.length ? (
              <div>
                <span style={{ color: "var(--fg-3)" }}>restarted: </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--fg-1)",
                  }}
                >
                  {turn.servicesRestarted.join(", ")}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}): JSX.Element {
  return (
    <div style={{ marginTop: "var(--sp-3)" }}>
      <div className="label">{title}</div>
      <pre
        style={{
          marginTop: "var(--sp-1)",
          maxHeight: 192,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          background: "var(--bg-base)",
          border: "1px solid var(--border-subtle)",
          padding: "var(--sp-2)",
          fontSize: "var(--text-xs)",
          color: "var(--fg-1)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {body || "(empty)"}
      </pre>
    </div>
  );
}
