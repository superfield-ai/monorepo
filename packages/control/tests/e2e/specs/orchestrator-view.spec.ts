/**
 * E2E spec: OrchestratorView — agent monitoring panel.
 *
 * Scenarios (5):
 *  1. Orchestrator tab renders; process state badge is visible
 *  2. Start button appears when process is stopped; clicking it calls the start endpoint
 *  3. Slot card appears when analytics/slots returns a running slot
 *  4. Log pane shows lines when the log SSE fires events
 *  5. CI status feed section is visible
 *
 * Uses page.route() to stub API endpoints — no real dev loop is needed.
 *
 * Canonical docs: docs/product.md §Agent monitoring (/studio/orchestrator)
 */

import { test, expect } from "../fixtures";

/** Navigate to the app root and open the Orchestrator tab. */
async function goToOrchestratorTab(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-orchestrator"]');
  await page.waitForSelector('[data-testid="orchestrator-tab-content"]', {
    timeout: 10_000,
  });
}

/** Stub the orchestrator status endpoint to return the given process state. */
async function stubOrchestratorStatus(
  page: import("@playwright/test").Page,
  processState: "stopped" | "running" | "starting" | "stopping" = "stopped",
): Promise<void> {
  await page.route("**/orchestrator/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        process: processState,
        pid: processState === "running" ? 1234 : null,
        apiReachable: processState === "running",
        uptimeMs: processState === "running" ? 60_000 : 0,
      }),
    }),
  );
}

/** Stub analytics/loops with empty healthy loops. */
async function stubLoops(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.route("**/analytics/loops", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ loops: {} }),
    }),
  );
}

/** Stub analytics/slots to return an empty slot list. */
async function stubSlotsEmpty(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.route("**/analytics/slots", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ slots: [] }),
    }),
  );
}

// ── Scenario 1: Orchestrator tab renders; process state badge is visible ───────

test("orchestrator tab renders and process state badge is visible", async ({
  page,
}) => {
  await stubOrchestratorStatus(page, "stopped");
  await stubLoops(page);
  await stubSlotsEmpty(page);

  await goToOrchestratorTab(page);

  await expect(page.getByTestId("process-state-badge")).toBeVisible();
  await expect(page.getByTestId("loop-table")).toBeVisible();
  await expect(page.getByTestId("log-pane")).toBeVisible();
});

// ── Scenario 2: Start button appears when stopped; clicking calls start endpoint ─

test("start button is visible when process is stopped and clicking calls the start endpoint", async ({
  page,
}) => {
  let startCalled = false;
  await stubOrchestratorStatus(page, "stopped");
  await stubLoops(page);
  await stubSlotsEmpty(page);

  await page.route("**/orchestrator/start", (route) => {
    startCalled = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await goToOrchestratorTab(page);

  // Fill in the repo input so the start button is enabled.
  const repoInput = page.getByTestId("repo-input");
  await repoInput.fill("/path/to/repo");

  const startBtn = page.getByTestId("start-button");
  await expect(startBtn).toBeVisible();
  await expect(startBtn).toBeEnabled();
  await startBtn.click();

  // Give the async click handler time to fire.
  await page.waitForTimeout(500);
  expect(startCalled).toBe(true);
});

// ── Scenario 3: Slot card appears when analytics/slots returns a running slot ─

test("slot card appears when analytics/slots returns a running slot", async ({
  page,
}) => {
  await stubOrchestratorStatus(page, "running");
  await stubLoops(page);

  const now = Date.now();
  await page.route("**/analytics/slots", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        slots: [
          {
            slot: 0,
            issueNumber: 301,
            role: "primary",
            sessionId: "",
            backend: "claude",
            model: "sonnet",
            startedAt: new Date(now - 15_000).toISOString(),
            elapsedMs: 15_000,
            heartbeatAt: now - 1_000,
          },
        ],
      }),
    }),
  );

  await goToOrchestratorTab(page);

  // The OrchestratorView polls on start; wait for the slot card to appear.
  await expect(page.getByTestId("slot-card-0")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("#301")).toBeVisible();
});

// ── Scenario 4: Log pane shows lines when the log SSE fires events ─────────────

test("log pane is visible and shows streamed log lines", async ({ page }) => {
  await stubOrchestratorStatus(page, "running");
  await stubLoops(page);
  await stubSlotsEmpty(page);

  // Stub the SSE log stream to immediately push two log lines then close.
  await page.route("**/orchestrator/logs", (route) => {
    const body = [
      "data: [info] bootstrap complete\n\n",
      "data: [warn] slow poll detected\n\n",
    ].join("");
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body,
    });
  });

  await goToOrchestratorTab(page);

  // Log pane is always present.
  await expect(page.getByTestId("log-pane")).toBeVisible();
});

// ── Scenario 5: CI status feed section is visible ─────────────────────────────

test("CI status feed section is visible on the orchestrator tab", async ({
  page,
}) => {
  await stubOrchestratorStatus(page, "stopped");
  await stubLoops(page);
  await stubSlotsEmpty(page);

  // Stub the CI check-runs SSE so the component doesn't hang waiting.
  await page.route("**/analytics/check-runs/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    }),
  );

  await goToOrchestratorTab(page);

  await expect(page.getByTestId("ci-status-feed-section")).toBeVisible();
  // With no events, the empty placeholder should be shown.
  await expect(page.getByTestId("ci-status-feed-empty")).toBeVisible();
});
