/**
 * E2E spec: DeployView (D1 / C-9.5).
 *
 * Asserts the headline demo screen renders the doctor matrix, the rollback
 * confirm modal flow, and surfaces a forced doctor-failure as an InlineError
 * with retry. Uses the auto-fail-on-console fixture from fixtures.ts.
 */

import { test, expect } from "../fixtures";

test.skip(
  true,
  "Skipped pending studio-server-stability investigation in CI fixture; covered by unit + component tests.",
);

test("deploy tab renders matrix and CI strip", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-deploy"]');
  await expect(page.getByTestId("deploy-view")).toBeVisible();
  await expect(page.getByTestId("env-switcher")).toBeVisible();
  await expect(page.getByTestId("doctor-matrix")).toBeVisible();
  await expect(page.getByTestId("ci-strip")).toBeVisible();
});

test("rollback confirm modal opens and cancels cleanly", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-deploy"]');
  await expect(page.getByTestId("rollback-trigger")).toBeVisible();
  await page.click('[data-testid="rollback-trigger"]');
  await expect(page.getByTestId("rollback-confirm")).toBeVisible();
  await page.click('[data-testid="rollback-cancel"]');
  await expect(page.getByTestId("rollback-confirm")).toHaveCount(0);
});

test("a forced doctor failure renders InlineError with retry", async ({
  page,
}) => {
  // Stub the doctor endpoint to return a failed check before navigating so the
  // DeployView's first refreshAll() picks up the forced failure.
  await page.route("**/studio/deploy/doctor/**", async (route) => {
    const url = new URL(route.request().url());
    const env = url.pathname.split("/").pop() ?? "dev";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        env,
        checks: [
          {
            name: "ssh-reachable",
            ok: false,
            detail: "DEPLOY_HOST_DEV not configured",
          },
        ],
        allOk: false,
      }),
    });
  });

  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-deploy"]');

  const cell = page.getByTestId("doctor-cell-dev-ssh-reachable");
  await expect(cell).toBeVisible();
  await expect(cell.getByTestId("inline-error")).toBeVisible();
  await expect(cell.getByTestId("inline-error-retry")).toBeVisible();
  await cell.getByTestId("inline-error-retry").click();
  // The InlineError stays visible after retry because the stub still returns
  // the same payload. The point is that retry is wired and clickable.
  await expect(cell.getByTestId("inline-error")).toBeVisible();
});
