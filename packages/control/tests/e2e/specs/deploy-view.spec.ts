/**
 * E2E spec: Deployment health view (/studio/deploy sub-tab).
 *
 * Exercises the DeployView component end-to-end via the Studio → Deploy
 * sub-tab. All HTTP endpoints are intercepted with page.route() stubs so no
 * live cluster is required.
 *
 * Covered scenarios:
 *   - Env switcher pills render and clicking a pill selects a new env
 *   - Doctor matrix populates from a stubbed /studio/deploy/doctor response
 *   - Rollback button opens confirm modal; prod requires typed env name (E13)
 *   - CI strip renders run-status cards from stubbed /studio/deploy/ci
 *   - Rollout log <pre> renders when rolloutLog is non-empty
 */

import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub all deploy API endpoints before each test. */
async function stubDeployApis(page: import("@playwright/test").Page) {
  // Environments — github source so envs are real
  await page.route("**/studio/deploy/envs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        envs: ["dev", "staging", "prod"],
        source: "github",
      }),
    }),
  );

  // Doctor responses per env
  const doctorChecks = {
    dev: [
      { name: "gh-auth", ok: true, detail: "authenticated" },
      { name: "ghcr-pull", ok: true, detail: "registry accessible" },
    ],
    staging: [
      { name: "gh-auth", ok: true, detail: "authenticated" },
      { name: "ghcr-pull", ok: false, detail: "GHCR_PAT_STAGING not set" },
    ],
    prod: [{ name: "gh-auth", ok: true, detail: "authenticated" }],
  };
  await page.route("**/studio/deploy/doctor/**", (route) => {
    const url = new URL(route.request().url());
    const env = decodeURIComponent(url.pathname.split("/").pop() ?? "dev");
    const checks =
      doctorChecks[env as keyof typeof doctorChecks] ?? doctorChecks.dev;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ env, checks, allOk: checks.every((c) => c.ok) }),
    });
  });

  // Secrets per env
  await page.route("**/studio/deploy/secrets/**", (route) => {
    const url = new URL(route.request().url());
    const env = decodeURIComponent(url.pathname.split("/").pop() ?? "dev");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        env,
        checks: [
          {
            name: `DEPLOY_HOST_${env.toUpperCase()}`,
            present: true,
            detail: "ok",
          },
          {
            name: `DEPLOY_KEY_${env.toUpperCase()}`,
            present: env !== "staging",
            detail: env === "staging" ? "missing" : "ok",
          },
        ],
      }),
    });
  });

  // CI runs
  await page.route("**/studio/deploy/ci", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            env: "dev",
            workflow: "deploy-dev.yml",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/example/repo/actions/runs/1",
            createdAt: new Date().toISOString(),
          },
          {
            env: "staging",
            workflow: "deploy-staging.yml",
            status: "completed",
            conclusion: "failure",
            url: "https://github.com/example/repo/actions/runs/2",
            createdAt: new Date().toISOString(),
          },
          {
            env: "prod",
            workflow: "deploy-prod.yml",
            status: "in_progress",
            conclusion: null,
            url: "https://github.com/example/repo/actions/runs/3",
            createdAt: new Date().toISOString(),
          },
        ],
        source: "github",
      }),
    }),
  );

  // Rollback POST — return a jobId
  await page.route("**/studio/deploy/rollback/**", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobId: "test-job-1" }),
      });
    }
    return route.continue();
  });

  // Rollback log SSE — emit a few lines then done
  await page.route("**/studio/deploy/rollback-log**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        "data: rolling back dev\n\n",
        "data: kubectl rollout undo deployment/app\n\n",
        "event: done\ndata: rollback complete\n\n",
      ].join(""),
    }),
  );

  // Migration log SSE
  await page.route("**/studio/deploy/migration-log**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        "data: migration log line 1\n\n",
        "event: done\ndata: done\n\n",
      ].join(""),
    }),
  );
}

/** Navigate to the Studio → Deploy sub-tab. */
async function goToDeploy(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-studio"]');
  await page.click('[data-testid="studio-sub-deploy"]');
  // Wait for the deploy view to mount
  await page.waitForSelector('[data-testid="deploy-view"]', {
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await stubDeployApis(page);
});

test("deploy-view renders and shows env switcher pills for all environments", async ({
  page,
}) => {
  await goToDeploy(page);
  await expect(page.getByTestId("env-switcher")).toBeVisible();
  await expect(page.getByTestId("env-pill-dev")).toBeVisible();
  await expect(page.getByTestId("env-pill-staging")).toBeVisible();
  await expect(page.getByTestId("env-pill-prod")).toBeVisible();
});

test("clicking an env pill changes the selected environment", async ({
  page,
}) => {
  await goToDeploy(page);
  // dev is selected by default (first env); switch to staging
  await page.click('[data-testid="env-pill-staging"]');
  await expect(page.getByTestId("env-pill-staging")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("env-pill-dev")).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

test("doctor matrix renders columns per env and rows per check name", async ({
  page,
}) => {
  await goToDeploy(page);
  await expect(page.getByTestId("doctor-matrix")).toBeVisible();
  // Columns
  await expect(page.getByTestId("doctor-col-dev")).toBeVisible();
  await expect(page.getByTestId("doctor-col-staging")).toBeVisible();
  await expect(page.getByTestId("doctor-col-prod")).toBeVisible();
  // Cell for a passing check
  await expect(page.getByTestId("doctor-cell-dev-gh-auth")).toBeVisible();
  await expect(
    page.getByTestId("doctor-cell-dev-gh-auth").getByTestId("doctor-ok"),
  ).toBeVisible();
});

test("doctor matrix shows InlineError for a failing check", async ({
  page,
}) => {
  await goToDeploy(page);
  // staging ghcr-pull is configured to fail in the stub
  const cell = page.getByTestId("doctor-cell-staging-ghcr-pull");
  await expect(cell).toBeVisible();
  await expect(cell.getByTestId("inline-error")).toBeVisible();
});

test("CI strip renders run-status cards from stubbed /studio/deploy/ci", async ({
  page,
}) => {
  await goToDeploy(page);
  await expect(page.getByTestId("ci-strip")).toBeVisible();
  await expect(page.getByTestId("ci-card-dev")).toBeVisible();
  await expect(page.getByTestId("ci-card-staging")).toBeVisible();
  await expect(page.getByTestId("ci-card-prod")).toBeVisible();
  // dev concluded success — the link text reflects the conclusion
  const devCard = page.getByTestId("ci-card-dev");
  await expect(devCard.locator("a")).toContainText("success");
});

test("rollback button opens confirmation modal", async ({ page }) => {
  await goToDeploy(page);
  // confirm modal should not be visible initially
  await expect(page.getByTestId("rollback-confirm")).not.toBeVisible();
  await page.click('[data-testid="rollback-trigger"]');
  await expect(page.getByTestId("rollback-confirm")).toBeVisible();
});

test("rollback modal cancel button closes the modal", async ({ page }) => {
  await goToDeploy(page);
  await page.click('[data-testid="rollback-trigger"]');
  await expect(page.getByTestId("rollback-confirm")).toBeVisible();
  await page.click('[data-testid="rollback-cancel"]');
  await expect(page.getByTestId("rollback-confirm")).not.toBeVisible();
});

test("prod rollback modal requires typed env name before confirm is enabled (E13)", async ({
  page,
}) => {
  await goToDeploy(page);
  // Switch to prod env
  await page.click('[data-testid="env-pill-prod"]');
  await page.click('[data-testid="rollback-trigger"]');
  await expect(page.getByTestId("rollback-confirm")).toBeVisible();

  // Confirm button should be disabled before typing
  await expect(page.getByTestId("rollback-confirm-action")).toBeDisabled();

  // Typing the wrong env name keeps the button disabled
  await page.fill('[data-testid="rollback-confirm-input"]', "dev");
  await expect(page.getByTestId("rollback-confirm-action")).toBeDisabled();

  // Typing the correct env name enables the confirm button
  await page.fill('[data-testid="rollback-confirm-input"]', "prod");
  await expect(page.getByTestId("rollback-confirm-action")).toBeEnabled();
});

test("dev rollback modal confirm is immediately enabled without a typed name", async ({
  page,
}) => {
  await goToDeploy(page);
  // dev is the default selected env — no typed-name gate applies
  await page.click('[data-testid="rollback-trigger"]');
  await expect(page.getByTestId("rollback-confirm")).toBeVisible();
  // No input element rendered for non-prod envs
  await expect(page.getByTestId("rollback-confirm-input")).not.toBeVisible();
  await expect(page.getByTestId("rollback-confirm-action")).toBeEnabled();
});

test("rollout log pre element renders after a confirmed rollback completes", async ({
  page,
}) => {
  await goToDeploy(page);
  // Trigger and confirm a dev rollback (no typed name required)
  await page.click('[data-testid="rollback-trigger"]');
  await page.click('[data-testid="rollback-confirm-action"]');
  // The rollback-log pre should appear after the SSE stream delivers lines
  await expect(page.getByTestId("rollback-log")).toBeVisible({
    timeout: 8_000,
  });
});
