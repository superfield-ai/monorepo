/**
 * Component tests for TurnSparkline (#251).
 *
 * Covers:
 *  - Renders bars proportional to turn costs
 *  - Returns null when all costs are zero
 *  - Returns null when turns array is empty
 *  - Last bar carries accent-green fill
 */

import React from "react";
import { render } from "vitest-browser-react";
import { describe, expect, test } from "vitest";
import { TurnSparkline } from "../../src/components/TurnSparkline";
import type { TurnSummary } from "../../src/components/TurnTimeline";

const makeTurn = (costUsd: number, ts: string): TurnSummary => ({
  ts,
  durationMs: 1000,
  tokens: 100,
  costUsd,
  exitStatus: "ok",
  prompt: "p",
  response: "r",
});

const TURNS: readonly TurnSummary[] = [
  makeTurn(0.001, "2026-01-01T00:00:00Z"),
  makeTurn(0.005, "2026-01-01T00:01:00Z"),
  makeTurn(0.003, "2026-01-01T00:02:00Z"),
];

describe("TurnSparkline", () => {
  test("renders one bar per turn when costs are non-zero", async () => {
    const screen = render(<TurnSparkline turns={TURNS} testId="sparkline" />);
    await expect.element(screen.getByTestId("sparkline")).toBeVisible();
    await expect.element(screen.getByTestId("sparkline-bar-0")).toBeVisible();
    await expect.element(screen.getByTestId("sparkline-bar-1")).toBeVisible();
    await expect.element(screen.getByTestId("sparkline-bar-2")).toBeVisible();
  });

  test("renders nothing when all costs are zero", async () => {
    const zeroCostTurns = TURNS.map((t) => ({ ...t, costUsd: 0 }));
    const screen = render(
      <TurnSparkline turns={zeroCostTurns} testId="sparkline-zero" />,
    );
    // Component returns null — the testId element should not exist.
    expect(
      screen.baseElement.querySelector('[data-testid="sparkline-zero"]'),
    ).toBeNull();
  });

  test("renders nothing when turns array is empty", async () => {
    const screen = render(
      <TurnSparkline turns={[]} testId="sparkline-empty" />,
    );
    expect(
      screen.baseElement.querySelector('[data-testid="sparkline-empty"]'),
    ).toBeNull();
  });

  test("last bar has accent-green fill", async () => {
    const screen = render(<TurnSparkline turns={TURNS} testId="sparkline-c" />);
    const lastBar = screen.baseElement.querySelector(
      '[data-testid="sparkline-bar-2"]',
    ) as SVGRectElement | null;
    expect(lastBar).not.toBeNull();
    expect(lastBar!.getAttribute("fill")).toBe("var(--accent-green)");
  });
});
