/**
 * Component tests for ChatPanelHeader.
 *
 * Covers:
 *  1. Renders label text correctly
 *  2. Renders actions children when provided
 *  3. When actions is omitted, the actions area is empty
 */

import React from "react";
import { render } from "vitest-browser-react";
import { expect, test } from "vitest";
import { ChatPanelHeader } from "../../src/components/chat/ChatPanelHeader";

test("renders label text correctly", async () => {
  const screen = render(<ChatPanelHeader label="AGENT — STUDIO" />);
  await expect.element(screen.getByText("AGENT — STUDIO")).toBeVisible();
});

test("renders actions children when provided", async () => {
  const screen = render(
    <ChatPanelHeader
      label="AGENT — PRODUCT"
      actions={<button>Reset session</button>}
    />,
  );
  await expect.element(screen.getByText("Reset session")).toBeVisible();
});

test("when actions is omitted, the actions area is empty", async () => {
  const { container } = render(<ChatPanelHeader label="AGENT — STUDIO" />);
  const header = container.querySelector("div");
  // The header itself has 2 children: the label span, and potentially an empty actions div.
  // When actions is omitted, there should be no children after the label
  const children = header?.children || [];
  // Should only have the label span, not an empty actions div
  expect(children.length).toBe(1);
});
