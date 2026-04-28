/**
 * E2E spec: every simulated failure surfaces a recoverable UI affordance (T3).
 *
 * Concrete scenarios:
 *   - 500 from a backend route → InlineError card with Retry / Copy details.
 *   - Page crash from a render-time exception → ErrorBoundary card with Retry.
 *   - Network drop → toast or banner with reconnect action.
 *
 * Uses the auto-fail-on-console fixture: any leak of console.error / .warn
 * is itself a test failure. The webapp does not intercept the JS console;
 * the operating principle is that no error path ends in a raw console call.
 */

import { test, expect } from "../fixtures";

test("debug badge renders with a numeric count on session load", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  const badge = page.locator('[data-testid="debug-badge"]');
  await expect(badge).toBeVisible();
  // The count is a small non-negative integer. In the CI fixture the studio
  // proxy returns 502s for /app/* (no cluster) and the dev-loop SSE may not
  // come up immediately — both are recorded by the foundation as typed
  // failures via the Result<T, AppError> wrappers, so the count is often
  // positive on first paint. The shape we assert is "the attribute exists
  // and is a base-10 integer", not a specific value.
  await expect(badge).toHaveAttribute("data-count", /^\d+$/);
});

test("a triggered error increments the badge count", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });

  // Read the count BEFORE we record, so the assertion is "increment", not
  // "non-zero" (the count may already be positive due to startup probes).
  const before = Number(
    (await page
      .locator('[data-testid="debug-badge"]')
      .getAttribute("data-count")) ?? "0",
  );

  // Use the __superfieldDebug test seam to record an entry without going
  // through the JS console (the auto-fixture would correctly fail on that)
  // and without triggering a pageerror.
  await page.evaluate(() => {
    const store = (
      globalThis as unknown as {
        __superfieldDebug?: {
          record(entry: {
            level: "error" | "warn" | "info" | "debug";
            source: string;
            message: string;
          }): void;
        };
      }
    ).__superfieldDebug;
    if (!store) throw new Error("__superfieldDebug not exposed on globalThis");
    store.record({ level: "error", source: "window", message: "counted" });
  });

  const after = Number(
    (await page
      .locator('[data-testid="debug-badge"]')
      .getAttribute("data-count")) ?? "0",
  );
  expect(after).toBeGreaterThan(before);
});

// ── Deeper failure simulations (T3) ───────────────────────────────────────────
//
// These specs use page.route() to fault-inject HTTP responses and assert that
// every failure mode reaches a labelled, recoverable UI affordance — not a
// blank screen, not a thrown promise. The "no surprises" demo guarantee.

test.describe("dev-loop API unreachable", () => {
  test("ConnectionBanner appears with Start dev loop button", async ({
    page,
  }) => {
    await page.route("**/orchestrator/status", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "unavailable", message: "dev loop not running" },
        }),
      }),
    );
    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    const banner = page.locator('[data-testid="connection-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(
      banner.locator('[data-testid="connection-banner-start"]'),
    ).toBeVisible();
    await expect(
      banner.locator('[data-testid="connection-banner-retry"]'),
    ).toBeVisible();
  });
});

test.describe("Deploy view failures", () => {
  test("doctor failure renders InlineError with Retry", async ({ page }) => {
    await page.route("**/studio/deploy/doctor/**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: {
            code: "internal",
            message: "doctor failed: missing DEPLOY_HOST_DEV",
            hint: "Run setup-github before deploy.",
          },
        }),
      }),
    );

    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    await page.click('[data-testid="tab-deploy"]');
    const view = page.locator('[data-testid="deploy-view"]');
    await expect(view).toBeVisible();
    await expect(view.getByRole("button", { name: /retry/i })).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe("Generic backend error envelope", () => {
  test("DebugView captures backend errors", async ({ page }) => {
    await page.route("**/studio/deploy/envs", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "internal", message: "envs unavailable" },
        }),
      }),
    );

    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    await page.click('[data-testid="tab-deploy"]');
    await page.click('[data-testid="debug-badge"]');
    const debug = page.locator('[data-testid="debug-view"]');
    await expect(debug).toBeVisible();
    await expect(debug).toContainText(/envs|unavailable|internal/i, {
      timeout: 10_000,
    });
  });
});

test.describe("iframe failure overlay", () => {
  test("cluster-down status surfaces the IframeOverlay", async ({ page }) => {
    // Mock cluster events SSE so the controller marks status degraded.
    await page.route("**/studio/cluster/events", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'event: status\ndata: {"status":"degraded"}\n\n',
      }),
    );

    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    const overlay = page.locator('[data-testid="iframe-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    await expect(overlay).toHaveAttribute("data-mode", "cluster-down");
    await expect(
      overlay.locator('[data-testid="iframe-overlay-rebuild"]'),
    ).toBeVisible();
  });
});
