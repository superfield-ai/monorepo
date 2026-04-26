/**
 * Component tests for ViewportToolbar (D4).
 *
 * Each button maps to its canonical width and toggling persists the choice.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { describe, expect, test, vi } from "vitest";
import {
  ViewportToolbar,
  VIEWPORT_WIDTHS,
  loadViewport,
  saveViewport,
  type Viewport,
} from "../../src/components/ViewportToolbar";

describe("ViewportToolbar", () => {
  test("renders three buttons with the active one aria-pressed", async () => {
    const onChange = vi.fn();
    const screen = render(
      <ViewportToolbar value="tablet" onChange={onChange} />,
    );
    await expect.element(screen.getByTestId("viewport-mobile")).toBeVisible();
    await expect.element(screen.getByTestId("viewport-tablet")).toBeVisible();
    await expect.element(screen.getByTestId("viewport-desktop")).toBeVisible();

    const tablet = screen.getByTestId("viewport-tablet");
    await expect.element(tablet).toHaveAttribute("aria-pressed", "true");
    const mobile = screen.getByTestId("viewport-mobile");
    await expect.element(mobile).toHaveAttribute("aria-pressed", "false");
  });

  test("clicking a button calls onChange with the right viewport", async () => {
    const onChange = vi.fn();
    const screen = render(
      <ViewportToolbar value="desktop" onChange={onChange} />,
    );
    await screen.getByTestId("viewport-mobile").click();
    expect(onChange).toHaveBeenCalledWith("mobile");
    await screen.getByTestId("viewport-tablet").click();
    expect(onChange).toHaveBeenCalledWith("tablet");
  });

  test("each named viewport maps to the canonical width", () => {
    expect(VIEWPORT_WIDTHS.mobile).toBe(390);
    expect(VIEWPORT_WIDTHS.tablet).toBe(768);
    expect(VIEWPORT_WIDTHS.desktop).toBe(1280);
  });

  test("loadViewport / saveViewport round-trip via localStorage", () => {
    saveViewport("tablet");
    expect(loadViewport()).toBe("tablet");
    saveViewport("mobile");
    expect(loadViewport()).toBe("mobile");
    // Restore default
    saveViewport("desktop");
    expect(loadViewport()).toBe("desktop");
  });

  test("loadViewport ignores unknown stored values", () => {
    window.localStorage.setItem("studio.viewport", "tv");
    const v: Viewport = loadViewport();
    expect(v).toBe("desktop");
  });
});
