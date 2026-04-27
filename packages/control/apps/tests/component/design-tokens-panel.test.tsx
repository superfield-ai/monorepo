/**
 * Component tests for DesignTokensPanel (D3).
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DesignTokensPanel,
  type DesignTokens,
} from "../../src/components/DesignTokensPanel";
import { toastStore } from "../../src/lib/toast-store";

const FIXTURE: DesignTokens = {
  colors: {
    "blue-500": "#3b82f6",
    "red-500": "#ef4444",
  },
  spacing: {
    "4": "1rem",
  },
  radii: {
    md: "0.375rem",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  toastStore.__resetForTest();
});

describe("DesignTokensPanel", () => {
  test("renders one section per non-empty group with token swatches", async () => {
    const screen = render(<DesignTokensPanel tokensOverride={FIXTURE} />);
    await expect
      .element(screen.getByTestId("design-tokens-panel"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("tokens-section-colors"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("tokens-section-spacing"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("tokens-section-radii"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("token-colors-blue-500"))
      .toBeVisible();
  });

  test("clicking a swatch copies the Tailwind class and shows a toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const screen = render(<DesignTokensPanel tokensOverride={FIXTURE} />);
    await screen.getByTestId("token-colors-blue-500").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(writeText).toHaveBeenCalledWith("bg-blue-500");
    const toasts = toastStore.getAll();
    expect(toasts.some((t) => t.title === "Copied to clipboard")).toBe(true);
  });

  test("renders fallback EmptyState when tokens are explicitly null", async () => {
    const screen = render(<DesignTokensPanel tokensOverride={null} />);
    await expect
      .element(screen.getByTestId("empty-state-design-tokens"))
      .toBeVisible();
  });
});
