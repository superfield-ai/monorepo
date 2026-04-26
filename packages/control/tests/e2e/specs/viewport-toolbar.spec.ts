/**
 * E2E spec: ViewportToolbar (D4).
 *
 * Asserts each viewport button sets the iframe width and the choice persists
 * across a page reload via localStorage. Uses the auto-fail-on-console
 * fixture from fixtures.ts.
 */

import { test, expect } from "../fixtures";

test("clicking mobile/tablet/desktop sets the iframe width", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await expect(page.getByTestId("viewport-toolbar")).toBeVisible();

  const iframe = page.getByTestId("app-iframe");

  await page.click('[data-testid="viewport-mobile"]');
  await expect(iframe).toHaveAttribute("style", /width:\s*390px/);

  await page.click('[data-testid="viewport-tablet"]');
  await expect(iframe).toHaveAttribute("style", /width:\s*768px/);

  await page.click('[data-testid="viewport-desktop"]');
  await expect(iframe).toHaveAttribute("style", /width:\s*1280px/);
});

test("viewport selection persists across reload via localStorage", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="viewport-tablet"]');
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  const iframe = page.getByTestId("app-iframe");
  await expect(iframe).toHaveAttribute("style", /width:\s*768px/);
});
