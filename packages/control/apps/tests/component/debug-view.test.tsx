/**
 * Component tests for DebugView.
 *
 * Covers the debug timeline surface end to end:
 *  - empty state
 *  - filtering by level, source, and search
 *  - row expansion for context / stack / breadcrumbs
 *  - clear action
 *  - clipboard copy
 *  - open-issue URL generation
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DebugView } from "../../src/components/DebugView";
import { debugStore } from "../../src/lib/debug-store";
import { toastStore } from "../../src/lib/toast-store";

beforeEach(() => {
  debugStore.__resetForTest();
  toastStore.__resetForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedEntries(): void {
  debugStore.record({
    level: "warn",
    source: "console",
    message: "Alpha console warning",
  });
  debugStore.record({
    level: "info",
    source: "fetch",
    message: "Beta fetch request",
  });
  debugStore.record({
    level: "error",
    source: "backend",
    message: "Gamma backend failure",
  });
}

describe("DebugView", () => {
  test("renders the empty state when no events exist", async () => {
    const screen = render(<DebugView />);

    await expect.element(screen.getByTestId("debug-view")).toBeVisible();
    await expect.element(screen.getByTestId("debug-view-count")).toBeVisible();
    await expect.element(screen.getByTestId("debug-empty")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          /No events recorded yet\. Errors, warnings, and debug events/,
        ),
      )
      .toBeVisible();
  });

  test("filters by level, source, and search text", async () => {
    seedEntries();

    const screen = render(<DebugView />);

    await expect
      .element(screen.getByTestId("debug-view-count"))
      .toHaveTextContent("3 / 3");
    await expect
      .element(screen.getByText("Alpha console warning"))
      .toBeVisible();
    await expect.element(screen.getByText("Beta fetch request")).toBeVisible();
    await expect
      .element(screen.getByText("Gamma backend failure"))
      .toBeVisible();

    await screen.getByTestId("debug-filter-level-warn").click();
    await expect
      .element(screen.getByTestId("debug-view-count"))
      .toHaveTextContent("2 / 3");
    expect(screen.container.textContent ?? "").not.toContain(
      "Alpha console warning",
    );
    await expect.element(screen.getByText("Beta fetch request")).toBeVisible();
    await expect
      .element(screen.getByText("Gamma backend failure"))
      .toBeVisible();

    await screen.getByTestId("debug-filter-source-fetch").click();
    await expect
      .element(screen.getByTestId("debug-view-count"))
      .toHaveTextContent("1 / 3");
    expect(screen.container.textContent ?? "").not.toContain(
      "Beta fetch request",
    );
    await expect
      .element(screen.getByText("Gamma backend failure"))
      .toBeVisible();

    const search = screen.getByTestId("debug-search");
    await search.fill("delta");
    await expect
      .element(screen.getByTestId("debug-view-count"))
      .toHaveTextContent("0 / 3");
    await expect.element(screen.getByTestId("debug-empty")).toBeVisible();
    await expect
      .element(screen.getByText(/NO MATCHING EVENTS — APPLICATION CLEAN\./i))
      .toBeVisible();
  });

  test("expanding a row reveals context, stack, breadcrumbs, and action buttons", async () => {
    debugStore.breadcrumb({
      category: "route",
      message: "→ /studio",
      ts: 1_700_000_000_000,
    });
    debugStore.record({
      level: "error",
      source: "backend",
      message: "Gamma backend failure",
      stack: "Error: boom\n    at worker.ts:12:4",
      context: {
        url: "/studio/debug/events",
        method: "GET",
        status: 500,
        correlationId: "corr-123",
      },
    });

    const screen = render(<DebugView />);

    await screen
      .getByRole("button", { name: /gamma backend failure/i })
      .click();
    await expect.element(screen.getByTestId("debug-row-detail")).toBeVisible();
    await expect.element(screen.getByText("CONTEXT")).toBeVisible();
    await expect.element(screen.getByText("STACK")).toBeVisible();
    await screen.getByText("BREADCRUMBS (1)").click();
    await expect.element(screen.getByText("BREADCRUMBS (1)")).toBeVisible();
    await expect.element(screen.getByText(/correlationId/i)).toBeVisible();
    await expect.element(screen.getByText(/worker\.ts:12:4/)).toBeVisible();
    await expect
      .element(screen.getByText(/\[route\]\s+→\s+\/studio/))
      .toBeVisible();
    await expect.element(screen.getByTestId("debug-row-copy")).toBeVisible();
    await expect.element(screen.getByTestId("debug-row-issue")).toBeVisible();
  });

  test("clear empties the store and returns to the empty state", async () => {
    seedEntries();

    const screen = render(<DebugView />);

    await screen.getByTestId("debug-clear").click();
    await expect.element(screen.getByTestId("debug-empty")).toBeVisible();
    await expect
      .element(screen.getByTestId("debug-view-count"))
      .toHaveTextContent("0 / 0");
  });

  test("copy to clipboard writes the entry and shows a success toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    debugStore.record({
      level: "warn",
      source: "console",
      message: "Clipboard test entry",
      context: { route: "/debug" },
    });

    const screen = render(<DebugView />);
    await screen.getByRole("button", { name: /clipboard test entry/i }).click();
    await screen.getByTestId("debug-row-copy").click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain(
      '"message": "Clipboard test entry"',
    );
    expect(
      toastStore.getAll().some((t) => t.title === "COPIED — DEBUG ENTRY"),
    ).toBe(true);
  });

  test("open issue uses the GitHub issue template with the entry payload", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    debugStore.record({
      level: "error",
      source: "backend",
      message: "Issue link test",
      context: { route: "/debug", status: 500 },
    });

    const screen = render(<DebugView />);
    await screen.getByRole("button", { name: /issue link test/i }).click();
    await screen.getByTestId("debug-row-issue").click();

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0] ?? [];
    expect(target).toBe("_blank");
    expect(features).toContain("noreferrer");
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/superfield-ai/monorepo/issues/new",
    );
    expect(parsed.searchParams.get("title")).toBe("[debug] Issue link test");
    expect(parsed.searchParams.get("body")).toContain('"status": 500');
  });
});
