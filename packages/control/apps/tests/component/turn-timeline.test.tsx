/**
 * Component tests for TurnTimeline (D6).
 */

import React from "react";
import { render } from "vitest-browser-react";
import { describe, expect, test } from "vitest";
import {
  TurnTimeline,
  type TurnSummary,
} from "../../src/components/TurnTimeline";

const FIXTURE: readonly TurnSummary[] = [
  {
    ts: "2026-04-26T01:00:00Z",
    durationMs: 4000,
    tokens: 0,
    costUsd: 0,
    exitStatus: "ok",
    prompt: "Add a discount-code input.",
    response: "Done.",
    filesChanged: ["app/checkout/discount.tsx"],
    servicesRestarted: ["web"],
  },
  {
    ts: "2026-04-26T02:00:00Z",
    durationMs: 8200,
    tokens: 0,
    costUsd: 0,
    exitStatus: "ok",
    prompt: "Debounce validation by 300ms.",
    response: "Added useDeferredValue.",
  },
];

describe("TurnTimeline", () => {
  test("renders one row per turn from the fixture", async () => {
    const screen = render(
      <TurnTimeline sessionId="abc" turnsOverride={FIXTURE} />,
    );
    await expect.element(screen.getByTestId("turn-timeline-abc")).toBeVisible();
    await expect.element(screen.getByTestId("turn-row-abc-0")).toBeVisible();
    await expect.element(screen.getByTestId("turn-row-abc-1")).toBeVisible();
    await expect
      .element(screen.getByText(/Add a discount-code input/))
      .toBeVisible();
  });

  test("clicking a turn row opens the modal with prompt and response", async () => {
    const screen = render(
      <TurnTimeline sessionId="abc" turnsOverride={FIXTURE} />,
    );
    await screen.getByTestId("turn-row-abc-0").click();
    const modal = screen.getByTestId("turn-modal");
    await expect.element(modal).toBeVisible();
    await expect.element(modal.getByText(/Done\./)).toBeVisible();
    await expect
      .element(modal.getByText(/app\/checkout\/discount\.tsx/))
      .toBeVisible();
    await screen.getByTestId("turn-modal-close").click();
  });

  test("renders EmptyState when no turns are present", async () => {
    const screen = render(<TurnTimeline sessionId="abc" turnsOverride={[]} />);
    await expect
      .element(screen.getByTestId("empty-state-timeline-abc"))
      .toBeVisible();
  });
});
