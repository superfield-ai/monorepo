/**
 * E2E spec: steer mode workflow.
 *
 * Exercises the primary operator user journey end-to-end:
 *   1. FeaturePane renders a running issue from the stubbed analytics/slots feed.
 *   2. Selecting the running issue opens the detail view with ACTIVE badge.
 *   3. Submitting a steer message dispatches to POST /studio/steer.
 *   4. The submitted message is reflected in the steer form (textarea clears).
 *   5. The detail header shows the selected issue number while in steer mode.
 *
 * All API calls are stubbed with page.route() — no real dev loop required.
 *
 * Canonical docs: docs/product.md §Chat workflow (steer / feature / product modes)
 */

import { test, expect } from "../fixtures";

const ISSUE_NUMBER = 42;
const SESSION_ID = "sess-42";

/**
 * Stub analytics/slots with one running slot for issue #42.
 * Also stub studio/issues so FeaturePaneController can build the feature list,
 * and stub studio/turns so TurnTimeline doesn't error.
 */
async function stubRunningSlot(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.route("**/analytics/slots", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        slots: [
          {
            slot: 0,
            issueNumber: ISSUE_NUMBER,
            role: "primary",
            sessionId: SESSION_ID,
            backend: "claude",
            model: "sonnet",
            startedAt: new Date().toISOString(),
            elapsedMs: 5_000,
            heartbeatAt: Date.now(),
          },
        ],
      }),
    }),
  );

  // Return the matching DB record so the controller has title + body.
  await page.route("**/studio/issues**", (route) => {
    const url = route.request().url();
    // POST stubs are handled separately in individual tests; only intercept GET/PATCH here.
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ number: ISSUE_NUMBER }),
      });
    }
    if (url.includes(`/studio/issues/${ISSUE_NUMBER}`)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          number: ISSUE_NUMBER,
          title: "running feature",
          body: "",
          status: "in_progress",
        }),
      });
    }
    // Default list response.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        issues: [
          {
            number: ISSUE_NUMBER,
            title: "running feature",
            body: "",
            status: "in_progress",
          },
        ],
      }),
    });
  });

  // Stub turn history so TurnTimeline renders without an error banner.
  await page.route("**/studio/turns/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessionId: SESSION_ID, turns: [] }),
    }),
  );
}

/** Navigate to the app and open the Studio → Features sub-view. */
async function goToStudioFeatures(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  // Studio tab is active by default; ensure the Features sub-view is selected.
  await page.getByTestId("studio-sub-features").click();
  await page.waitForSelector('[data-testid="feature-pane"]', {
    timeout: 10_000,
  });
}

// ── Scenario 1: IssueRail (FeaturePane) renders the running issue ─────────────

test("feature list renders the stubbed running issue", async ({ page }) => {
  await stubRunningSlot(page);
  await goToStudioFeatures(page);

  // The feature rail always shows the feature list on wide viewports.
  await expect(page.getByTestId("feature-list")).toBeVisible();
  // The running slot must appear as a row in the rail.
  await expect(page.getByTestId(`feature-row-${ISSUE_NUMBER}`)).toBeVisible({
    timeout: 10_000,
  });
});

// ── Scenario 2: Selecting the running issue switches to steer mode ────────────

test("selecting the running issue opens the detail view with ACTIVE badge", async ({
  page,
}) => {
  await stubRunningSlot(page);
  await goToStudioFeatures(page);

  await page.waitForSelector(`[data-testid="feature-row-${ISSUE_NUMBER}"]`, {
    timeout: 10_000,
  });
  await page.click(`[data-testid="feature-row-${ISSUE_NUMBER}"]`);

  // Detail panel must be visible.
  await expect(page.getByTestId("feature-detail")).toBeVisible();

  // The header should show the issue number.
  await expect(
    page.getByTestId("feature-detail").getByText(`#${ISSUE_NUMBER}`),
  ).toBeVisible();

  // The ACTIVE badge is shown when the feature has a live sessionId.
  await expect(
    page.getByTestId("feature-detail").getByText("ACTIVE"),
  ).toBeVisible();
});

// ── Scenario 3: Submitting a steer message dispatches to /studio/steer ────────

test("submitting a steer message dispatches to POST /studio/steer", async ({
  page,
}) => {
  await stubRunningSlot(page);

  let steerBody: unknown = null;
  await page.route("**/studio/steer", async (route) => {
    steerBody = JSON.parse(
      (await route.request().postData()) ?? "{}",
    ) as unknown;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await goToStudioFeatures(page);
  await page.waitForSelector(`[data-testid="feature-row-${ISSUE_NUMBER}"]`, {
    timeout: 10_000,
  });
  await page.click(`[data-testid="feature-row-${ISSUE_NUMBER}"]`);
  await expect(page.getByTestId("feature-detail")).toBeVisible();

  // Type a steer message into the steer textarea and submit.
  const steerTextarea = page.getByTestId("feature-detail").locator("textarea");
  await steerTextarea.fill("focus on the auth module");
  await page.keyboard.press("Enter");

  // Give the async POST time to fire.
  await page.waitForTimeout(500);

  expect(steerBody).not.toBeNull();
  const body = steerBody as { context?: string; sessionId?: string };
  expect(body.context).toBe("focus on the auth module");
  expect(body.sessionId).toBe(SESSION_ID);
});

// ── Scenario 4: Textarea clears after submission ───────────────────────────────

test("steer textarea clears after submission", async ({ page }) => {
  await stubRunningSlot(page);
  await page.route("**/studio/steer", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await goToStudioFeatures(page);
  await page.waitForSelector(`[data-testid="feature-row-${ISSUE_NUMBER}"]`, {
    timeout: 10_000,
  });
  await page.click(`[data-testid="feature-row-${ISSUE_NUMBER}"]`);
  await expect(page.getByTestId("feature-detail")).toBeVisible();

  const steerTextarea = page.getByTestId("feature-detail").locator("textarea");
  await steerTextarea.fill("redirect all traffic to the new handler");
  await page.keyboard.press("Enter");

  // After submit the ActionForm clears its local state.
  await expect(steerTextarea).toHaveValue("", { timeout: 3_000 });
});

// ── Scenario 5: Detail header reflects the selected issue number ───────────────

test("detail header reflects the selected issue number while in steer mode", async ({
  page,
}) => {
  await stubRunningSlot(page);
  await goToStudioFeatures(page);

  await page.waitForSelector(`[data-testid="feature-row-${ISSUE_NUMBER}"]`, {
    timeout: 10_000,
  });
  await page.click(`[data-testid="feature-row-${ISSUE_NUMBER}"]`);
  await expect(page.getByTestId("feature-detail")).toBeVisible();

  // The detail header must clearly identify the active issue number.
  const header = page
    .getByTestId("feature-detail")
    .locator("[style*='border-bottom']")
    .first();
  await expect(header.getByText(`#${ISSUE_NUMBER}`)).toBeVisible();
  // The title from the stub is also shown.
  await expect(
    page.getByTestId("feature-detail").getByText("running feature"),
  ).toBeVisible();
});
