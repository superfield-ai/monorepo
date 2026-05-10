/**
 * @file TurnSparkline
 *
 * Cost-over-time sparkline for the analytics panel (C-9.7 / #251).
 * Renders a tiny SVG bar chart showing cumulative USD cost per turn.
 *
 * Usage:
 *   <TurnSparkline turns={turns} width={120} height={32} />
 *
 * Each bar represents one turn. Bar height is proportional to the
 * turn's costUsd relative to the maximum in the dataset. The last
 * bar is highlighted with the accent-green token.
 *
 * Canonical docs: None (new sub-component).
 */

import React from "react";
import type { TurnSummary } from "./TurnTimeline";

interface TurnSparklineProps {
  readonly turns: readonly TurnSummary[];
  /** SVG width in px. Default 120. */
  readonly width?: number;
  /** SVG height in px. Default 32. */
  readonly height?: number;
  /** data-testid on the root svg. Default "turn-sparkline". */
  readonly testId?: string;
}

/** Maximum number of bars displayed (newest N turns). */
const MAX_BARS = 20;

/**
 * TurnSparkline renders a miniature cost-over-time bar chart.
 * Returns null when there are no turns or all turns have zero cost.
 */
export function TurnSparkline({
  turns,
  width = 120,
  height = 32,
  testId = "turn-sparkline",
}: TurnSparklineProps): JSX.Element | null {
  if (turns.length === 0) return null;

  const visible = turns.slice(-MAX_BARS);
  const maxCost = Math.max(...visible.map((t) => t.costUsd));
  // Render nothing if all costs are zero — no meaningful sparkline.
  if (maxCost <= 0) return null;

  const barCount = visible.length;
  const gap = 1;
  const barWidth = Math.max(1, (width - gap * (barCount - 1)) / barCount);
  const minBarHeight = 2; // always at least 2px so zero-cost bars are visible

  return (
    <svg
      data-testid={testId}
      width={width}
      height={height}
      aria-label="Cost per turn sparkline"
      style={{ display: "block", overflow: "visible" }}
    >
      {visible.map((turn, idx) => {
        const ratio = maxCost > 0 ? turn.costUsd / maxCost : 0;
        const barH = Math.max(minBarHeight, Math.round(ratio * (height - 2)));
        const x = Math.round(idx * (barWidth + gap));
        const y = height - barH;
        const isLast = idx === barCount - 1;
        return (
          <rect
            key={`${turn.ts}-${idx}`}
            data-testid={`sparkline-bar-${idx}`}
            x={x}
            y={y}
            width={Math.floor(barWidth)}
            height={barH}
            fill={isLast ? "var(--accent-green)" : "var(--fg-3)"}
            opacity={isLast ? 1 : 0.5}
          >
            <title>{`$${turn.costUsd.toFixed(4)} — ${turn.ts}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
