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
  test("both tab buttons are visible", async ({ page }) => {
    await goToStudio(page);
    await expect(page.getByTestId("tab-studio")).toBeVisible();
    await expect(page.getByTestId("tab-viewport")).toBeVisible();
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
  });
});

// ---------------------------------------------------------------------------
// Studio tab
// ---------------------------------------------------------------------------

test.describe("Studio tab", () => {
  test("chat panel is visible on load", async ({ page }) => {
    await goToStudio(page);
    await expect(page.getByTestId("chat-panel")).toBeVisible();
  });

  test("orchestrator view is visible on load", async ({ page }) => {
    await goToStudio(page);
    await expect(page.getByTestId("process-state-badge")).toBeVisible();
  });

  test("cluster status indicator is present", async ({ page }) => {
    await goToStudio(page);
    await expect(page.getByTestId("cluster-status-indicator")).toBeVisible();
  });

  test("chat input accepts text", async ({ page }) => {
    await goToStudio(page);
    const input = page.getByTestId("chat-input");
    await input.fill("hello from e2e");
    await expect(input).toHaveValue("hello from e2e");
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

  test("Studio tab content disappears after switching", async ({ page }) => {
    await expect(page.getByTestId("chat-panel")).not.toBeVisible();
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
  test("switching back to Studio tab restores the chat panel", async ({
    page,
  }) => {
    await goToStudio(page);
    await page.getByTestId("tab-viewport").click();
    await page.waitForSelector('[data-testid="iframe-panel"]');

    await page.getByTestId("tab-studio").click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
  });

  test("only one tab content visible at a time", async ({ page }) => {
    await goToStudio(page);

    // On Studio tab: chat visible, iframe not visible.
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("iframe-panel")).not.toBeVisible();

    // On Viewport tab: iframe visible, chat not visible.
    await page.getByTestId("tab-viewport").click();
    await page.waitForSelector('[data-testid="iframe-panel"]');
    await expect(page.getByTestId("chat-panel")).not.toBeVisible();
    await expect(page.getByTestId("iframe-panel")).toBeVisible();
  });
});
