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
          title="Failed to load turn timeline"
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
        className="mt-2 text-xs text-zinc-500"
      >
        <EmptyState
          title="No turns recorded yet"
          hint="The agent has not produced any turns for this session."
          testId={`timeline-${sessionId}`}
        />
      </div>
    );
  }

  return (
    <div data-testid={`turn-timeline-${sessionId}`} className="mt-2">
      <ol className="flex flex-col gap-1">
        {turns.map((turn, idx) => (
          <li key={`${turn.ts}-${idx}`}>
            <button
              type="button"
              data-testid={`turn-row-${sessionId}-${idx}`}
              onClick={() => setActive(turn)}
              className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-left text-xs hover:border-zinc-400"
            >
              <div className="flex items-center justify-between text-[11px] text-gray-500">
                <span className="font-mono">{formatTs(turn.ts)}</span>
                <span>{formatDuration(turn.durationMs)}</span>
              </div>
              <div className="truncate text-gray-800">
                {turn.prompt || "(no prompt)"}
              </div>
            </button>
          </li>
        ))}
      </ol>
      {active ? (
        <TurnModal turn={active} onClose={() => setActive(null)} />
      ) : null}
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
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded border border-zinc-700 bg-zinc-950 p-4 text-sm text-zinc-100"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Turn detail</h3>
          <button
            type="button"
            data-testid="turn-modal-close"
            onClick={onClose}
            className="rounded border border-zinc-600 px-2 py-0.5 text-xs hover:border-zinc-400"
          >
            Close
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-400">
          <dt>Timestamp</dt>
          <dd className="text-zinc-200">{turn.ts}</dd>
          <dt>Duration</dt>
          <dd className="text-zinc-200">{formatDuration(turn.durationMs)}</dd>
          <dt>Exit</dt>
          <dd className="text-zinc-200">{turn.exitStatus}</dd>
          <dt>Tokens</dt>
          <dd className="text-zinc-200">{turn.tokens || "—"}</dd>
        </dl>

        <Section title="Prompt" body={turn.prompt} />
        <Section title="Response" body={turn.response} />

        {(turn.filesChanged?.length ?? 0) > 0 ||
        (turn.servicesRestarted?.length ?? 0) > 0 ? (
          <div className="mt-3 rounded border border-zinc-800 p-2 text-xs">
            <div className="mb-1 uppercase tracking-wide text-zinc-500">
              Tool-call summary
            </div>
            {turn.filesChanged?.length ? (
              <div>
                <span className="text-zinc-400">files: </span>
                <span className="font-mono text-zinc-200">
                  {turn.filesChanged.join(", ")}
                </span>
              </div>
            ) : null}
            {turn.servicesRestarted?.length ? (
              <div>
                <span className="text-zinc-400">restarted: </span>
                <span className="font-mono text-zinc-200">
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
    <div className="mt-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-black/50 p-2 text-xs text-zinc-100">
        {body || "(empty)"}
      </pre>
    </div>
  );
}
