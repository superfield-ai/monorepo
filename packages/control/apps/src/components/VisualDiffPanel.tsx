/**
 * @file VisualDiffPanel.tsx
 *
 * Side-by-side before/after visual diff for a completed agent turn (issue #250).
 *
 * Fetches diff metadata from:
 *   GET /studio/screenshots/diff/:sessionId/:beforeTurn/:afterTurn
 *
 * Then renders two PNG thumbnails side by side. When a screenshot does not
 * exist (Playwright not installed, or turn not captured) it shows a placeholder
 * so the panel never breaks the Turn Timeline.
 *
 *   <VisualDiffPanel sessionId="…" beforeTurn={1} afterTurn={2} />
 *
 * C-11.2: Also exports `TestOutputPane` — an expandable panel that fetches
 *   GET /analytics/check-runs?sha=<commitSha>
 * and renders the failing test suite stdout/stderr with minimal ANSI→HTML
 * colouring. Default-collapsed when all checks pass; default-expanded when
 * any check failed (or when the caller passes `defaultExpanded={true}`).
 *
 * Canonical docs: docs/studio-e2e-infrastructure.md — "Per-turn screenshot capture"
 */

import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../lib/net";
import type { AppError } from "../lib/errors";
import type { CheckRun, CheckRunsResponse } from "../lib/check-runs";

export interface VisualDiffPanelProps {
  readonly sessionId: string;
  /** Turn index before the agent ran (0 means no prior screenshot). */
  readonly beforeTurn: number;
  /** Turn index after the agent ran. */
  readonly afterTurn: number;
  /**
   * Override the fetched diff data (for tests / Storybook).
   * When provided, no network request is made.
   */
  readonly diffOverride?: VisualDiffData | null;
}

export interface VisualDiffData {
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly beforeExists: boolean;
  readonly afterExists: boolean;
}

interface DiffApiResponse {
  readonly sessionId: string;
  readonly beforeTurn: number;
  readonly afterTurn: number;
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly beforeExists: boolean;
  readonly afterExists: boolean;
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase" as const,
  color: "var(--fg-3)",
  marginBottom: "var(--sp-1)",
  display: "block",
};

const PLACEHOLDER_STYLE: React.CSSProperties = {
  width: "100%",
  aspectRatio: "16/9",
  background: "var(--bg-base)",
  border: "1px dashed var(--border-subtle)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase" as const,
};

const IMG_STYLE: React.CSSProperties = {
  width: "100%",
  aspectRatio: "16/9",
  objectFit: "cover",
  border: "1px solid var(--border-subtle)",
  display: "block",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function ScreenshotSlot({
  label,
  url,
  exists,
  testId,
}: {
  readonly label: string;
  readonly url: string;
  readonly exists: boolean;
  readonly testId: string;
}): JSX.Element {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <span style={LABEL_STYLE}>{label}</span>
      {exists ? (
        <img
          src={url}
          alt={label}
          style={IMG_STYLE}
          data-testid={testId}
          loading="lazy"
        />
      ) : (
        <div style={PLACEHOLDER_STYLE} data-testid={`${testId}-placeholder`}>
          NO CAPTURE
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Side-by-side before/after screenshots for a single agent turn.
 *
 * When `diffOverride` is provided the component renders immediately without
 * any network request — useful in tests and Storybook.
 */
export function VisualDiffPanel({
  sessionId,
  beforeTurn,
  afterTurn,
  diffOverride,
}: VisualDiffPanelProps): JSX.Element {
  const [diff, setDiff] = useState<VisualDiffData | null>(
    diffOverride !== undefined ? (diffOverride ?? null) : null,
  );
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(diffOverride === undefined);

  useEffect(() => {
    if (diffOverride !== undefined) {
      setDiff(diffOverride ?? null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const url = `/studio/screenshots/diff/${encodeURIComponent(sessionId)}/${beforeTurn}/${afterTurn}`;
      const result = await fetchJson<DiffApiResponse>(url);
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setDiff({
        beforeUrl: result.value.beforeUrl,
        afterUrl: result.value.afterUrl,
        beforeExists: result.value.beforeExists,
        afterExists: result.value.afterExists,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, beforeTurn, afterTurn, diffOverride]);

  if (loading) {
    return (
      <div
        data-testid="visual-diff-loading"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--fg-3)",
          letterSpacing: "var(--ls-wider)",
          textTransform: "uppercase",
          padding: "var(--sp-2) 0",
        }}
      >
        LOADING DIFF…
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="visual-diff-error"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--accent-red, #e06c75)",
          letterSpacing: "var(--ls-wider)",
          textTransform: "uppercase",
          padding: "var(--sp-2) 0",
        }}
      >
        DIFF UNAVAILABLE
      </div>
    );
  }

  if (!diff) return <></>;

  return (
    <div
      data-testid="visual-diff-panel"
      style={{
        display: "flex",
        gap: "var(--sp-2)",
        marginTop: "var(--sp-2)",
      }}
    >
      <ScreenshotSlot
        label="BEFORE"
        url={diff.beforeUrl}
        exists={diff.beforeExists}
        testId="visual-diff-before"
      />
      <ScreenshotSlot
        label="AFTER"
        url={diff.afterUrl}
        exists={diff.afterExists}
        testId="visual-diff-after"
      />
    </div>
  );
}

// ── C-11.2: TestOutputPane ────────────────────────────────────────────────────

/**
 * Minimal ANSI escape-sequence → HTML span converter.
 *
 * Supports 3/4-bit foreground colours (30–37, 90–97) and the reset code (0).
 * Strips all other escape sequences rather than rendering them verbatim.
 *
 * @param text - Raw string that may contain ANSI CSI sequences.
 * @returns An array of `{ text, color? }` segments safe for rendering as spans.
 */
function parseAnsi(text: string): Array<{ text: string; color?: string }> {
  const ANSI_COLORS: Record<number, string> = {
    30: "#1e1e1e",
    31: "var(--accent-red, #e06c75)",
    32: "var(--accent-green, #39d98a)",
    33: "var(--accent-amber, #e5c07b)",
    34: "#61afef",
    35: "#c678dd",
    36: "#56b6c2",
    37: "#abb2bf",
    90: "var(--fg-3)",
    91: "#e06c75",
    92: "#39d98a",
    93: "#e5c07b",
    94: "#61afef",
    95: "#c678dd",
    96: "#56b6c2",
    97: "#ffffff",
  };

  const segments: Array<{ text: string; color?: string }> = [];
  // Split on any CSI sequence: ESC [ … m
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  let currentColor: string | undefined;

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Plain text segment
      if (parts[i]) segments.push({ text: parts[i], color: currentColor });
    } else {
      // Control code(s)
      const codes = parts[i].split(";").map(Number);
      for (const code of codes) {
        if (code === 0) {
          currentColor = undefined;
        } else if (ANSI_COLORS[code] !== undefined) {
          currentColor = ANSI_COLORS[code];
        }
        // Other codes (bold, italic, etc.) are ignored.
      }
    }
  }
  return segments;
}

export interface TestOutputPaneProps {
  readonly commitSha: string;
  /**
   * Whether the pane starts in the expanded state.
   * Defaults to `true` when any check has failed; otherwise `false`.
   */
  readonly defaultExpanded?: boolean;
  /** Override for tests / Storybook — skips the network fetch. */
  readonly checkRunsOverride?: readonly CheckRun[];
}

/**
 * TestOutputPane — expandable pane showing failing test suite stdout/stderr.
 *
 * Renders below `VisualDiffPanel` inside the TurnTimeline row. When all tests
 * pass the pane is collapsed by default; when any check fails it opens.
 * The toggle button is always visible so the operator can expand/collapse
 * regardless of status.
 *
 * ANSI escape codes in test output are converted to coloured `<span>` elements
 * by the local `parseAnsi` helper (no external dependencies required).
 */
export function TestOutputPane({
  commitSha,
  defaultExpanded,
  checkRunsOverride,
}: TestOutputPaneProps): JSX.Element {
  const [runs, setRuns] = useState<readonly CheckRun[]>(
    checkRunsOverride ?? [],
  );
  const [loading, setLoading] = useState(checkRunsOverride === undefined);
  const [fetchError, setFetchError] = useState<AppError | null>(null);

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
        setFetchError(null);
      } else {
        setFetchError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commitSha, checkRunsOverride]);

  const hasFailed = useMemo(
    () =>
      runs.some(
        (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
      ),
    [runs],
  );

  const [expanded, setExpanded] = useState<boolean>(
    defaultExpanded ?? hasFailed,
  );

  // Update expanded state if run results arrive and show failures.
  useEffect(() => {
    if (defaultExpanded === undefined && hasFailed) {
      setExpanded(true);
    }
  }, [hasFailed, defaultExpanded]);

  const failedRuns = useMemo(
    () =>
      runs.filter(
        (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
      ),
    [runs],
  );

  const statusLabel = loading
    ? "LOADING…"
    : hasFailed
      ? `${failedRuns.length} FAILED`
      : runs.length > 0
        ? "ALL PASSED"
        : "NO CHECKS";

  const statusColor = loading
    ? "var(--fg-3)"
    : hasFailed
      ? "var(--accent-red, #e06c75)"
      : "var(--accent-green, #39d98a)";

  return (
    <div
      data-testid={`test-output-pane-${commitSha}`}
      style={{
        border: "1px solid var(--border-subtle)",
        borderTop: "none",
        background: "var(--bg-void, #0a0a0a)",
      }}
    >
      {/* Header / toggle */}
      <button
        type="button"
        data-testid={`test-output-toggle-${commitSha}`}
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--sp-1) var(--sp-2)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          letterSpacing: "var(--ls-wider)",
          textTransform: "uppercase",
          color: "var(--fg-3)",
        }}
      >
        <span style={{ color: statusColor }}>{statusLabel}</span>
        <span>{expanded ? "▲ COLLAPSE" : "▼ EXPAND"}</span>
      </button>

      {expanded && (
        <div
          data-testid={`test-output-body-${commitSha}`}
          style={{
            padding: "var(--sp-2)",
            maxHeight: 320,
            overflowY: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            lineHeight: "var(--lh-normal)",
          }}
        >
          {loading && (
            <span style={{ color: "var(--fg-3)" }}>Loading check runs…</span>
          )}
          {fetchError && (
            <span style={{ color: "var(--accent-red, #e06c75)" }}>
              {fetchError.message}
            </span>
          )}
          {!loading && !fetchError && runs.length === 0 && (
            <span style={{ color: "var(--fg-3)" }}>No check runs found.</span>
          )}
          {!loading &&
            !fetchError &&
            (hasFailed ? failedRuns : runs).map((run, i) => {
              const rawOutput = [
                run.output?.title,
                run.output?.summary,
                run.output?.text,
              ]
                .filter(Boolean)
                .join("\n");

              return (
                <div
                  key={`${run.name}-${i}`}
                  style={{
                    marginBottom: "var(--sp-2)",
                    borderBottom: "1px solid var(--border-subtle)",
                    paddingBottom: "var(--sp-2)",
                  }}
                >
                  <div
                    style={{
                      color:
                        run.conclusion === "failure" ||
                        run.conclusion === "timed_out"
                          ? "var(--accent-red, #e06c75)"
                          : "var(--accent-green, #39d98a)",
                      marginBottom: "var(--sp-1)",
                    }}
                  >
                    {run.name}
                    {run.conclusion && ` — ${run.conclusion}`}
                  </div>
                  {rawOutput ? (
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        color: "var(--fg-1)",
                      }}
                    >
                      {parseAnsi(rawOutput).map((seg, si) => (
                        <span
                          key={si}
                          style={seg.color ? { color: seg.color } : undefined}
                        >
                          {seg.text}
                        </span>
                      ))}
                    </pre>
                  ) : (
                    <span style={{ color: "var(--fg-3)" }}>(no output)</span>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
