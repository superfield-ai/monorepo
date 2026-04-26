/**
 * Studio webapp E2E tests — all three views.
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
    await expect(page.getByTestId("tab-orchestrator")).toBeVisible();
    await expect(page.getByTestId("tab-preview")).toBeVisible();
  });

  test("Studio tab is active by default", async ({ page }) => {
    await goToStudio(page);
    // Active tab has the blue border-b-2 class.
    const studioBtn = page.getByTestId("tab-studio");
    await expect(studioBtn).toHaveClass(/border-b-2/);
    // Other tabs do not.
    await expect(page.getByTestId("tab-orchestrator")).not.toHaveClass(
      /border-b-2/,
    );
    await expect(page.getByTestId("tab-preview")).not.toHaveClass(/border-b-2/);
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

  test("iframe panel is visible on load", async ({ page }) => {
    await goToStudio(page);
    await expect(page.getByTestId("iframe-panel")).toBeVisible();
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
// Orchestrator tab
// ---------------------------------------------------------------------------

test.describe("Orchestrator tab", () => {
  test.beforeEach(async ({ page }) => {
    await goToStudio(page);
    await page.getByTestId("tab-orchestrator").click();
    // Wait for the OrchestratorView to mount — the process badge is always present.
    await page.waitForSelector('[data-testid="process-state-badge"]', {
      timeout: 10_000,
    });
  });

  test("Studio tab content disappears after switching", async ({ page }) => {
    await expect(page.getByTestId("chat-panel")).not.toBeVisible();
    await expect(page.getByTestId("iframe-panel")).not.toBeVisible();
  });

  test("process state badge is visible and shows stopped", async ({ page }) => {
    const badge = page.getByTestId("process-state-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("stopped");
  });

  test("Start button is present and disabled without a repo path", async ({
    page,
  }) => {
    const startBtn = page.getByTestId("start-button");
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toBeDisabled();
  });

  test("Start button enables once a repo path is entered", async ({ page }) => {
    await page.getByTestId("repo-input").fill("/tmp/test-repo");
    await expect(page.getByTestId("start-button")).toBeEnabled();
  });

  test("Stop button is disabled when process is stopped", async ({ page }) => {
    await expect(page.getByTestId("stop-button")).toBeDisabled();
  });

  test("loop table is visible with plan, dev, doc rows", async ({ page }) => {
    const table = page.getByTestId("loop-table");
    await expect(table).toBeVisible();
    await expect(table.getByText("plan")).toBeVisible();
    await expect(table.getByText("dev")).toBeVisible();
    await expect(table.getByText("doc")).toBeVisible();
  });

  test("loop rows show circuit state", async ({ page }) => {
    const table = page.getByTestId("loop-table");
    // All three loops should show "closed" circuit (default state).
    const closedCells = table.getByText("closed");
    await expect(closedCells.first()).toBeVisible();
    await expect(closedCells).toHaveCount(3);
  });

  test('log pane is visible with "Dev loop logs" heading', async ({ page }) => {
    const logPane = page.getByTestId("log-pane");
    await expect(logPane).toBeVisible();
    await expect(logPane.getByText("Dev loop logs")).toBeVisible();
  });

  test("API reachability indicator is visible", async ({ page }) => {
    // The API indicator shows "reachable" or "unreachable" — either is valid here.
    await expect(page.getByText(/API (reachable|unreachable)/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Preview tab
// ---------------------------------------------------------------------------

test.describe("Preview tab", () => {
  test.beforeEach(async ({ page }) => {
    await goToStudio(page);
    await page.getByTestId("tab-preview").click();
    await page.waitForSelector('[data-testid="preview-view-selector"]', {
      timeout: 10_000,
    });
  });

  test("Studio and Orchestrator tab content disappears after switching", async ({
    page,
  }) => {
    await expect(page.getByTestId("chat-panel")).not.toBeVisible();
    await expect(page.getByTestId("process-state-badge")).not.toBeVisible();
  });

  test("all three view buttons are present", async ({ page }) => {
    await expect(page.getByTestId("preview-view-wiki")).toBeVisible();
    await expect(page.getByTestId("preview-view-citations")).toBeVisible();
    await expect(page.getByTestId("preview-view-empty")).toBeVisible();
  });

  test("WikiRender view is active by default", async ({ page }) => {
    const wikiBtn = page.getByTestId("preview-view-wiki");
    await expect(wikiBtn).toHaveClass(/bg-blue-50/);
  });

  test("WikiRender content shows a heading", async ({ page }) => {
    // The WikiPreview renders WIKI_FIXTURE which contains h1 "Component Preview".
    await expect(
      page
        .getByTestId("preview-content")
        .getByRole("heading", { name: "Component Preview" }),
    ).toBeVisible();
  });

  test("WikiRender output escapes HTML — no live <script> in DOM", async ({
    page,
  }) => {
    const scripts = await page
      .getByTestId("preview-content")
      .locator("script")
      .count();
    expect(scripts).toBe(0);
  });

  test("clicking Citations shows the citation marker", async ({ page }) => {
    await page.getByTestId("preview-view-citations").click();
    // The citation marker is [1] inside a <sup>.
    await expect(
      page.getByTestId("preview-content").getByText("[1]"),
    ).toBeVisible();
  });

  test("clicking Empty Shell shows placeholder text", async ({ page }) => {
    await page.getByTestId("preview-view-empty").click();
    await expect(
      page.getByTestId("preview-content").getByText(/Add a component here/),
    ).toBeVisible();
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
    await page.getByTestId("tab-orchestrator").click();
    await page.waitForSelector('[data-testid="process-state-badge"]');

    await page.getByTestId("tab-studio").click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
  });

  test("only one tab content visible at a time", async ({ page }) => {
    await goToStudio(page);

    // On Studio tab: chat visible, orchestrator badge not visible.
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("process-state-badge")).not.toBeVisible();
    await expect(page.getByTestId("preview-view-selector")).not.toBeVisible();

    // On Orchestrator tab: badge visible, chat and preview not visible.
    await page.getByTestId("tab-orchestrator").click();
    await page.waitForSelector('[data-testid="process-state-badge"]');
    await expect(page.getByTestId("chat-panel")).not.toBeVisible();
    await expect(page.getByTestId("preview-view-selector")).not.toBeVisible();

    // On Preview tab: preview visible, chat and badge not visible.
    await page.getByTestId("tab-preview").click();
    await page.waitForSelector('[data-testid="preview-view-selector"]');
    await expect(page.getByTestId("chat-panel")).not.toBeVisible();
    await expect(page.getByTestId("process-state-badge")).not.toBeVisible();
  });
});
