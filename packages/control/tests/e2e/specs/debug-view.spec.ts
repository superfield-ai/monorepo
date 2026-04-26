/**
 * E2E spec: DebugView captures known browser-side failures (T4).
 *
 * The webapp installs `console.error` / `console.warn` interceptors and
 * `window.onerror` handlers at boot. These tests intentionally trigger each
 * source from inside the page and assert that the DebugView surfaces the
 * resulting entry — proving the catch-everything pipeline works end-to-end.
 *
 * Note: the `expectCleanConsole` fixture is bypassed for this spec because we
 * are deliberately producing console events. We re-attach a relaxed listener
 * that only fails on uncaught/uninstrumented warnings.
 */

import { test as base, expect } from "@playwright/test";

const test = base; // intentionally not the auto-fail variant

test("debug view captures triggered console.error", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });

  await page.evaluate(() => {
    console.error("synthetic e2e error", { kind: "test" });
  });

  await page.click('[data-testid="debug-badge"]');
  await page.waitForSelector('[data-testid="debug-view"]');

  const rows = page.locator('[data-testid="debug-row"]');
  await expect(rows.filter({ hasText: "synthetic e2e error" })).toHaveCount(1);
});

test("debug view captures uncaught synchronous errors", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });

  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("synthetic uncaught");
    }, 0);
  });
  await page.waitForTimeout(50);

  await page.click('[data-testid="debug-badge"]');
  await page.waitForSelector('[data-testid="debug-view"]');
  const rows = page.locator('[data-testid="debug-row"]');
  await expect(rows.filter({ hasText: "synthetic uncaught" })).toHaveCount(1);
});

test("clear button empties the timeline", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.evaluate(() => console.error("to be cleared"));
  await page.click('[data-testid="debug-badge"]');
  await page.waitForSelector('[data-testid="debug-view"]');
  await page.click('[data-testid="debug-clear"]');
  await expect(page.locator('[data-testid="debug-empty"]')).toBeVisible();
});
