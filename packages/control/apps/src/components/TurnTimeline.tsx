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
 * opens a modal with the full prompt body, response, and a tool-call summary
 * (currently the file/service lists from the seed JSONL).
 */

import React, { useEffect, useState } from "react";
import { fetchJson } from "../lib/net";
import type { AppError } from "../lib/errors";
import { EmptyState } from "./EmptyState";
import { InlineError } from "./InlineError";
import { TurnSparkline } from "./TurnSparkline";

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
                <span>{formatDuration(turn.durationMs)}</span>
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
          </li>
        ))}
      </ol>
      {active ? (
        <TurnModal turn={active} onClose={() => setActive(null)} />
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
  onClose,
}: {
  readonly turn: TurnSummary;
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
