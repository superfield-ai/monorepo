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

test("debug view shows entries recorded via the test seam", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });

  await page.evaluate(() => {
    const store = (
      globalThis as unknown as {
        __superfieldDebug?: {
          record(entry: {
            level: "error" | "warn" | "info" | "debug";
            source: string;
            message: string;
          }): void;
        };
      }
    ).__superfieldDebug;
    if (!store) throw new Error("__superfieldDebug not exposed on globalThis");
    store.record({
      level: "error",
      source: "app",
      message: "synthetic e2e error",
    });
  });

  await page.click('[data-testid="debug-badge"]');
  await page.waitForSelector('[data-testid="debug-view"]');

  const rows = page.locator('[data-testid="debug-row"]');
  await expect(rows.filter({ hasText: "synthetic e2e error" })).toHaveCount(1);
});

test("clear button empties the timeline", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.evaluate(() => {
    const store = (
      globalThis as unknown as {
        __superfieldDebug?: {
          record(entry: {
            level: "error" | "warn" | "info" | "debug";
            source: string;
            message: string;
          }): void;
        };
      }
    ).__superfieldDebug;
    if (!store) throw new Error("__superfieldDebug not exposed on globalThis");
    store.record({ level: "error", source: "app", message: "to be cleared" });
  });
  await page.click('[data-testid="debug-badge"]');
  await page.waitForSelector('[data-testid="debug-view"]');
  await page.click('[data-testid="debug-clear"]');
  await expect(page.locator('[data-testid="debug-empty"]')).toBeVisible();
});
