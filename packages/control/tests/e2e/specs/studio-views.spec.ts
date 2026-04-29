/**
 * Studio webapp E2E tests — Studio and Viewport views.
 *
 * Runs against the real studio server serving the built Vite app. No mocks.
 * Both servers (studio + superfield API) are started by global-setup.ts.
 *
 * Pre-requisite: build the web app before running.
 *   bun run --cwd packages/control/apps build
 *
 * Run:
 *   npx playwright test --config packages/control/tests/e2e/playwright.config.ts
 */
import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// Navigation helper
// ---------------------------------------------------------------------------

async function goToStudio(page: import("@playwright/test").Page) {
  await page.goto("/");
  // Wait for the React app to boot — the tab bar is the first interactive
  // element present once the SPA has mounted.
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

test.describe("tab bar", () => {
  test("all three tab buttons are visible", async ({ page }) => {
    await goToStudio(page);
    await expect(page.getByTestId("tab-studio")).toBeVisible();
    await expect(page.getByTestId("tab-viewport")).toBeVisible();
    await expect(page.getByTestId("tab-product")).toBeVisible();
  });

  test("Studio tab is active by default", async ({ page }) => {
    await goToStudio(page);
    // Active tab carries data-active="true" (the design system uses a
    // semantic attribute rather than a class for active state — see NavTab in
    // ControlPanel.tsx).
    await expect(page.getByTestId("tab-studio")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByTestId("tab-viewport")).toHaveAttribute(
      "data-active",
      "false",
    );
    await expect(page.getByTestId("tab-product")).toHaveAttribute(
      "data-active",
      "false",
    );
  });
});

// ---------------------------------------------------------------------------
// Studio tab
// ---------------------------------------------------------------------------

test.describe("Studio tab", () => {
  test("feature pane is visible on load", async ({ page }) => {
    await goToStudio(page);
    await expect(page.getByTestId("feature-pane")).toBeVisible();
  });

  test("feature list is shown by default", async ({ page }) => {
    await goToStudio(page);
    await expect(page.getByTestId("feature-list")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Viewport tab
// ---------------------------------------------------------------------------

test.describe("Viewport tab", () => {
  test.beforeEach(async ({ page }) => {
    await goToStudio(page);
    await page.getByTestId("tab-viewport").click();
    // Wait for the IframePanel to mount.
    await page.waitForSelector('[data-testid="iframe-panel"]', {
      timeout: 10_000,
    });
  });

  test("Studio tab feature-pane disappears after switching", async ({
    page,
  }) => {
    await expect(page.getByTestId("feature-pane")).not.toBeVisible();
  });

  test("iframe panel is visible", async ({ page }) => {
    await expect(page.getByTestId("iframe-panel")).toBeVisible();
  });

  test("viewport toolbar is visible", async ({ page }) => {
    await expect(page.getByTestId("viewport-toolbar")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tab switching — state persistence
// ---------------------------------------------------------------------------

test.describe("tab switching", () => {
  test("switching back to Studio tab restores the feature pane", async ({
    page,
  }) => {
    await goToStudio(page);
    await page.getByTestId("tab-viewport").click();
    await page.waitForSelector('[data-testid="iframe-panel"]');

    await page.getByTestId("tab-studio").click();
    await expect(page.getByTestId("feature-pane")).toBeVisible();
  });

  test("only one tab content visible at a time", async ({ page }) => {
    await goToStudio(page);

    // On Studio tab: feature-pane visible, iframe not visible.
    await expect(page.getByTestId("feature-pane")).toBeVisible();
    await expect(page.getByTestId("iframe-panel")).not.toBeVisible();

    // On Viewport tab: iframe visible, feature-pane not visible.
    await page.getByTestId("tab-viewport").click();
    await page.waitForSelector('[data-testid="iframe-panel"]');
    await expect(page.getByTestId("feature-pane")).not.toBeVisible();
    await expect(page.getByTestId("iframe-panel")).toBeVisible();
  });

  test("switching to Product tab shows docs viewer and product chat", async ({
    page,
  }) => {
    await goToStudio(page);
    await page.getByTestId("tab-product").click();
    await expect(page.getByTestId("product-tab")).toBeVisible();
    await expect(page.getByTestId("docs-viewer")).toBeVisible();
    await expect(page.getByTestId("product-chat-panel")).toBeVisible();
  });
});
