/**
 * Component tests for VisualDiffPanel (issue #250).
 *
 * Uses `diffOverride` to avoid any network calls.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { describe, expect, test } from "vitest";
import {
  VisualDiffPanel,
  type VisualDiffData,
} from "../../src/components/VisualDiffPanel";

const BOTH_EXIST: VisualDiffData = {
  beforeUrl: "/studio/screenshots/sess/turn-1.png",
  afterUrl: "/studio/screenshots/sess/turn-2.png",
  beforeExists: true,
  afterExists: true,
};

const BEFORE_MISSING: VisualDiffData = {
  beforeUrl: "/studio/screenshots/sess/turn-0.png",
  afterUrl: "/studio/screenshots/sess/turn-1.png",
  beforeExists: false,
  afterExists: true,
};

const BOTH_MISSING: VisualDiffData = {
  beforeUrl: "/studio/screenshots/sess/turn-0.png",
  afterUrl: "/studio/screenshots/sess/turn-1.png",
  beforeExists: false,
  afterExists: false,
};

describe("VisualDiffPanel", () => {
  test("renders both images when both screenshots exist", async () => {
    const screen = render(
      <VisualDiffPanel
        sessionId="sess"
        beforeTurn={1}
        afterTurn={2}
        diffOverride={BOTH_EXIST}
      />,
    );
    await expect.element(screen.getByTestId("visual-diff-panel")).toBeVisible();
    await expect
      .element(screen.getByTestId("visual-diff-before"))
      .toBeVisible();
    await expect.element(screen.getByTestId("visual-diff-after")).toBeVisible();
  });

  test("shows placeholder for missing before screenshot", async () => {
    const screen = render(
      <VisualDiffPanel
        sessionId="sess"
        beforeTurn={0}
        afterTurn={1}
        diffOverride={BEFORE_MISSING}
      />,
    );
    await expect
      .element(screen.getByTestId("visual-diff-before-placeholder"))
      .toBeVisible();
    await expect.element(screen.getByTestId("visual-diff-after")).toBeVisible();
  });

  test("shows placeholders when both screenshots are missing", async () => {
    const screen = render(
      <VisualDiffPanel
        sessionId="sess"
        beforeTurn={0}
        afterTurn={1}
        diffOverride={BOTH_MISSING}
      />,
    );
    await expect
      .element(screen.getByTestId("visual-diff-before-placeholder"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("visual-diff-after-placeholder"))
      .toBeVisible();
  });

  test("renders nothing when diffOverride is null", async () => {
    const screen = render(
      <VisualDiffPanel
        sessionId="sess"
        beforeTurn={1}
        afterTurn={2}
        diffOverride={null}
      />,
    );
    // When diffOverride is null the component renders an empty fragment
    const panel = screen.container.querySelector(
      '[data-testid="visual-diff-panel"]',
    );
    expect(panel).toBeNull();
  });
});
