/**
 * E2E spec: FeaturePane and turn timeline coverage.
 *
 * Asserts the Studio tab renders the current feature list, selecting a feature
 * opens the detail view with the session timeline, and a failed timeline fetch
 * surfaces an InlineError with retry. Uses the auto-fail-on-console fixture
 * from fixtures.ts.
 */

import { test, expect } from "../fixtures";

const SESSION_ID = "demo-session-1";

test.beforeEach(async ({ page }) => {
  await page.route("**/analytics/slots", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        slots: [
          {
            slot: 1,
            issueNumber: 301,
            role: "dev",
            backend: "claude",
            model: "opus",
            elapsedMs: 12_000,
            heartbeatAt: Date.now(),
            sessionId: SESSION_ID,
            startedAt: new Date().toISOString(),
          },
        ],
      }),
    }),
  );
  await page.route("**/studio/turns/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: SESSION_ID,
        turns: [
          {
            ts: "2026-04-26T01:00:00Z",
            durationMs: 4_000,
            tokens: 0,
            costUsd: 0,
            exitStatus: "ok",
            prompt: "Add a discount-code input on /checkout.",
            response: "Done.",
            filesChanged: ["app/checkout/discount.tsx"],
            servicesRestarted: ["web"],
          },
        ],
      }),
    });
  });
});

test("studio tab renders the feature list and opens the detail view", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-studio"]');
  await expect(page.getByTestId("feature-pane")).toBeVisible();
  await expect(page.getByTestId("feature-list")).toBeVisible();
  await expect(page.getByTestId("feature-row-301")).toBeVisible();

  await page.click('[data-testid="feature-row-301"]');
  await expect(page.getByTestId("feature-detail")).toBeVisible();
  await expect(page.getByTestId("turn-timeline-demo-session-1")).toBeVisible();
  await expect(page.getByTestId("turn-row-demo-session-1-0")).toBeVisible();
});

test("feature detail back button returns to the list", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-studio"]');
  await page.click('[data-testid="feature-row-301"]');
  await expect(page.getByTestId("feature-detail")).toBeVisible();
  await page.click('[data-testid="feature-back"]');
  await expect(page.getByTestId("feature-list")).toBeVisible();
});

test("a forced turn timeline failure renders InlineError with retry", async ({
  page,
}) => {
  await page.route("**/studio/turns/**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: {
          code: "unavailable",
          message: "turn history unavailable",
        },
      }),
    });
  });

  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-studio"]');
  await page.click('[data-testid="feature-row-301"]');

  const timeline = page.getByTestId("turn-timeline-demo-session-1");
  await expect(timeline).toBeVisible();
  await expect(timeline.getByTestId("inline-error")).toBeVisible();
  await expect(timeline.getByTestId("inline-error-retry")).toBeVisible();
});
