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
 * Canonical docs: docs/studio-e2e-infrastructure.md — "Per-turn screenshot capture"
 */

import React, { useEffect, useState } from "react";
import { fetchJson } from "../lib/net";
import type { AppError } from "../lib/errors";

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
