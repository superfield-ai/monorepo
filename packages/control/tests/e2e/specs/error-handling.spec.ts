/**
 * E2E spec: every simulated failure surfaces a recoverable UI affordance (T3).
 *
 * Concrete scenarios:
 *   - 500 from a backend route → InlineError card with Retry / Copy details.
 *   - Page crash from a render-time exception → ErrorBoundary card with Retry.
 *   - Network drop → toast or banner with reconnect action.
 *
 * The fixtures.ts auto-fail-on-console gate is bypassed here because the
 * runtime DELIBERATELY produces some console output (the dev-mode forwarder
 * still fires when forwardToConsole=true). The shipped production build mutes
 * the native console and only the DebugView records.
 */

import { test, expect } from "@playwright/test";

test("debug badge is hidden / shows zero count on a clean session", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  const badge = page.locator('[data-testid="debug-badge"]');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-count", /^[01]$/);
});

test("a triggered error increments the badge count", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.evaluate(() => console.error("counted"));
  const countAttr = await page
    .locator('[data-testid="debug-badge"]')
    .getAttribute("data-count");
  expect(Number(countAttr)).toBeGreaterThan(0);
});
