/**
 * E2E spec: steer flow — full user journey from feature selection to turn log.
 *
 * Tests the primary day-to-day operator workflow in the Studio tab:
 *   1. Selecting a feature row with an active slot unlocks the steer textarea.
 *   2. Typing in the steer textarea and pressing Enter fires POST /studio/steer.
 *   3. Clicking the STEER button also fires POST /studio/steer.
 *   4. After submit the textarea is cleared.
 *   5. The resulting turn appears in the turn timeline on next poll.
 *
 * All API calls are stubbed with page.route() — no real dev loop required.
 *
 * Canonical docs:
 *   - docs/product.md §Chat workflow (steer / feature / product modes)
 *   - docs/ux/studio-ux.md
 *   - docs/code-review/test-coverage-2026-05-28.md
 */

import { test, expect } from "../fixtures";

const ISSUE_NUMBER = 77;
const SESSION_ID = "sess-77";
const STEER_MESSAGE = "focus on the payment module";

/**
 * Stub analytics/slots with one running slot for ISSUE_NUMBER.
 * Also stub studio/issues and studio/turns so the feature pane loads cleanly.
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

  await page.route("**/studio/issues**", (route) => {
    const url = route.request().url();
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
          title: "payment integration",
          body: "",
          status: "in_progress",
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        issues: [
          {
            number: ISSUE_NUMBER,
            title: "payment integration",
            body: "",
            status: "in_progress",
          },
        ],
      }),
    });
  });

  // Default stub: empty turn list. Individual tests override this for poll tests.
  await page.route("**/studio/turns/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessionId: SESSION_ID, turns: [] }),
    }),
  );
}

/** Navigate to the app and wait for the feature pane to load. */
async function goToStudioFeatures(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="feature-pane"]', {
    timeout: 10_000,
  });
}

/** Click the feature row and wait for the detail panel. */
async function selectFeature(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.waitForSelector(`[data-testid="feature-row-${ISSUE_NUMBER}"]`, {
    timeout: 10_000,
  });
  await page.click(`[data-testid="feature-row-${ISSUE_NUMBER}"]`);
  await expect(page.getByTestId("feature-detail")).toBeVisible();
}

// ── Scenario 1: Active slot unlocks the steer textarea ───────────────────────

test("selecting a feature row with an active slot shows the steer form", async ({
  page,
}) => {
  await stubRunningSlot(page);
  await goToStudioFeatures(page);
  await selectFeature(page);

  // The detail panel must be visible and show the ACTIVE badge.
  const detail = page.getByTestId("feature-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByText("ACTIVE")).toBeVisible();

  // The steer textarea (placeholder contains "Steer") must be present and editable.
  const textarea = detail.locator("textarea");
  await expect(textarea).toBeVisible();
  await expect(textarea).toBeEnabled();
  await expect(textarea).toHaveAttribute("placeholder", /steer/i);

  // The STEER submit button must be present.
  await expect(detail.getByRole("button", { name: /^STEER$/i })).toBeVisible();
});

// ── Scenario 2: Enter-key fires POST /studio/steer ───────────────────────────

test("pressing Enter in the steer textarea fires POST /studio/steer", async ({
  page,
}) => {
  await stubRunningSlot(page);

  let capturedBody: Record<string, unknown> | null = null;
  await page.route("**/studio/steer", async (route) => {
    capturedBody = JSON.parse(
      (await route.request().postData()) ?? "{}",
    ) as Record<string, unknown>;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await goToStudioFeatures(page);
  await selectFeature(page);

  const textarea = page.getByTestId("feature-detail").locator("textarea");
  await textarea.fill(STEER_MESSAGE);
  await page.keyboard.press("Enter");

  await page.waitForTimeout(500);

  expect(capturedBody).not.toBeNull();
  expect(capturedBody!.context).toBe(STEER_MESSAGE);
  expect(capturedBody!.sessionId).toBe(SESSION_ID);
});

// ── Scenario 3: STEER button click fires POST /studio/steer ─────────────────

test("clicking the STEER button fires POST /studio/steer", async ({ page }) => {
  await stubRunningSlot(page);

  let capturedBody: Record<string, unknown> | null = null;
  await page.route("**/studio/steer", async (route) => {
    capturedBody = JSON.parse(
      (await route.request().postData()) ?? "{}",
    ) as Record<string, unknown>;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await goToStudioFeatures(page);
  await selectFeature(page);

  const detail = page.getByTestId("feature-detail");
  const textarea = detail.locator("textarea");
  const steerButton = detail.getByRole("button", { name: /^STEER$/i });

  await textarea.fill(STEER_MESSAGE);
  await steerButton.click();

  await page.waitForTimeout(500);

  expect(capturedBody).not.toBeNull();
  expect(capturedBody!.context).toBe(STEER_MESSAGE);
  expect(capturedBody!.sessionId).toBe(SESSION_ID);
});

// ── Scenario 4: Textarea clears after Enter-key submit ───────────────────────

test("steer textarea clears after Enter-key submission", async ({ page }) => {
  await stubRunningSlot(page);
  await page.route("**/studio/steer", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await goToStudioFeatures(page);
  await selectFeature(page);

  const textarea = page.getByTestId("feature-detail").locator("textarea");
  await textarea.fill(STEER_MESSAGE);
  await page.keyboard.press("Enter");

  await expect(textarea).toHaveValue("", { timeout: 3_000 });
});

// ── Scenario 5: Textarea clears after button-click submit ────────────────────

test("steer textarea clears after button-click submission", async ({
  page,
}) => {
  await stubRunningSlot(page);
  await page.route("**/studio/steer", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await goToStudioFeatures(page);
  await selectFeature(page);

  const detail = page.getByTestId("feature-detail");
  const textarea = detail.locator("textarea");
  const steerButton = detail.getByRole("button", { name: /^STEER$/i });

  await textarea.fill(STEER_MESSAGE);
  await steerButton.click();

  await expect(textarea).toHaveValue("", { timeout: 3_000 });
});

// ── Scenario 6: New turn appears in the session log after steer ──────────────

test("new turn appears in the turn timeline after steer submission", async ({
  page,
}) => {
  await stubRunningSlot(page);

  // Override the turns stub: first call returns empty, second returns one turn.
  let pollCount = 0;
  await page.unroute("**/studio/turns/**");
  await page.route("**/studio/turns/**", (route) => {
    pollCount += 1;
    const turns =
      pollCount >= 2
        ? [
            {
              ts: new Date().toISOString(),
              durationMs: 3_000,
              tokens: 120,
              costUsd: 0.001,
              exitStatus: "ok",
              prompt: STEER_MESSAGE,
              response: "Understood, focusing on payment module.",
              filesChanged: [],
              servicesRestarted: [],
            },
          ]
        : [];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessionId: SESSION_ID, turns }),
    });
  });

  await page.route("**/studio/steer", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await goToStudioFeatures(page);
  await selectFeature(page);

  const textarea = page.getByTestId("feature-detail").locator("textarea");
  await textarea.fill(STEER_MESSAGE);
  await page.keyboard.press("Enter");

  // The turn-timeline row must appear after the next polling cycle.
  const timeline = page.getByTestId(`turn-timeline-${SESSION_ID}`);
  await expect(timeline).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId(`turn-row-${SESSION_ID}-0`)).toBeVisible({
    timeout: 10_000,
  });
});
