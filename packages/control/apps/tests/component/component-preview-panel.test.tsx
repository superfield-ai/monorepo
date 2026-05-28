/**
 * Component tests for ComponentPreviewPanel (issue #322).
 *
 * Verifies view-selector buttons render and that clicking each one switches the
 * active content area.  No network calls — the panel is entirely fixture-driven.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { describe, expect, test } from "vitest";
import { ComponentPreviewPanel } from "../../src/components/ComponentPreviewPanel";

describe("ComponentPreviewPanel", () => {
  test("renders the view selector with all four buttons", async () => {
    const screen = render(<ComponentPreviewPanel />);
    await expect
      .element(screen.getByTestId("preview-view-selector"))
      .toBeVisible();
    await expect.element(screen.getByTestId("preview-view-wiki")).toBeVisible();
    await expect
      .element(screen.getByTestId("preview-view-citations"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("preview-view-tokens"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("preview-view-empty"))
      .toBeVisible();
  });

  test("wiki view is shown by default", async () => {
    const screen = render(<ComponentPreviewPanel />);
    await expect.element(screen.getByTestId("preview-content")).toBeVisible();
    // The WikiRender article element should be present inside the content area.
    const article = screen.container.querySelector("article");
    expect(article).not.toBeNull();
  });

  test("clicking citations view renders the citation marker", async () => {
    const screen = render(<ComponentPreviewPanel />);
    await screen.getByTestId("preview-view-citations").click();
    // The citation fixture sup element "[1]" should now be in the DOM.
    const sup = screen.container.querySelector("sup");
    expect(sup).not.toBeNull();
    expect(sup?.textContent).toContain("[1]");
  });

  test("clicking tokens view renders the design-tokens panel", async () => {
    const screen = render(<ComponentPreviewPanel />);
    await screen.getByTestId("preview-view-tokens").click();
    await expect
      .element(screen.getByTestId("design-tokens-panel"))
      .toBeVisible();
  });

  test("clicking empty view renders the empty-shell placeholder", async () => {
    const screen = render(<ComponentPreviewPanel />);
    await screen.getByTestId("preview-view-empty").click();
    const content = screen.getByTestId("preview-content");
    await expect.element(content).toBeVisible();
    // The EmptyShell renders a dashed-border placeholder.
    const placeholder = screen.container.querySelector(".border-dashed");
    expect(placeholder).not.toBeNull();
  });
});
