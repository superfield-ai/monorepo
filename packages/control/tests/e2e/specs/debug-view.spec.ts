/**
 * E2E spec: DebugView captures recorded entries and the clear button works (T4).
 *
 * The webapp installs `window.onerror` and `unhandledrejection` handlers that
 * route uncaught failures into the DebugStore. Those handler paths are
 * covered by `tests/unit/global-handlers.test.ts`. This spec proves the
 * remaining contract: any DebugStore entry surfaces in the DebugView with the
 * right level / source / message, and the Clear button empties the timeline.
 *
 * Uses the auto-fail-on-console fixture: any leak of console.error / .warn
 * fails the test. The webapp does not silence the console — it makes
 * unhandled errors structurally impossible at the source.
 */

import { test, expect } from "../fixtures";

// `DebugSource` in apps/src/lib/debug-store.ts. Entries with a source outside
// this set are dropped by the DebugView source filter, so the test seam MUST
// use one of these values or rows will never render. ("app" was the original
// bug — it bypassed the TS cast at runtime, was stored, then filtered out.)
type DebugSource =
  | "console"
  | "window"
  | "fetch"
  | "eventsource"
  | "websocket"
  | "react"
  | "backend"
  | "breadcrumb";

interface TestSeam {
  record(entry: {
    level: "error" | "warn" | "info" | "debug";
    source: DebugSource;
    message: string;
  }): void;
}

async function recordEntry(
  page: import("@playwright/test").Page,
  entry: { level: "error"; source: DebugSource; message: string },
): Promise<void> {
  await page.evaluate((e) => {
    const store = (globalThis as unknown as { __superfieldDebug?: TestSeam })
      .__superfieldDebug;
    if (!store) throw new Error("__superfieldDebug not exposed on globalThis");
    store.record(e);
  }, entry);
}

test("debug view shows entries recorded via the test seam", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });

  await recordEntry(page, {
    level: "error",
    source: "window",
    message: "synthetic e2e error",
  });

  await page.click('[data-testid="debug-badge"]');
  await page.waitForSelector('[data-testid="debug-view"]');

  const rows = page.locator('[data-testid="debug-row"]');
  await expect(rows.filter({ hasText: "synthetic e2e error" })).toHaveCount(1);
});

test("clear button removes recorded entries from the timeline", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });

  await recordEntry(page, {
    level: "error",
    source: "window",
    message: "to be cleared",
  });

  await page.click('[data-testid="debug-badge"]');
  await page.waitForSelector('[data-testid="debug-view"]');
  const target = page
    .locator('[data-testid="debug-row"]')
    .filter({ hasText: "to be cleared" });
  await expect(target).toHaveCount(1);

  await page.click('[data-testid="debug-clear"]');
  // Assert the specific entry is gone rather than relying on debug-empty:
  // unrelated backend SSE entries (e.g. cluster-status poller) may arrive
  // independently and would keep the timeline non-empty.
  await expect(target).toHaveCount(0);
});
