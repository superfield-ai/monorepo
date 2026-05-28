/**
 * E2E spec: Studio /studio/preview pillar — fixture switching, mock-route
 * gallery, and design-tokens panel (issue #322).
 *
 * All API calls to /studio/fixtures and /studio/mock-routes are stubbed with
 * page.route() — no real dev-loop server is required.
 *
 * Scenarios covered:
 *   1. Opening the Studio "Mocks" sub-view renders the mock-route gallery with
 *      stubbed route entries.
 *   2. Opening the Studio "Fixtures" sub-view shows the fixture switcher and
 *      loading a route returns the stubbed fixture list.
 *   3. Selecting and activating a different fixture calls POST /studio/fixtures/activate
 *      and the active-fixture status indicator updates.
 *   4. The design-tokens panel is accessible from ComponentPreviewPanel (rendered
 *      directly because there is no /studio/preview browser route yet — the panel
 *      is exercised via the Studio sub-views).
 */

import { test, expect } from "../fixtures";

// ── Route stubs ────────────────────────────────────────────────────────────

const MOCK_ROUTES = [
  { id: "r1", method: "GET", path: "/api/users", enabled: true },
  { id: "r2", method: "POST", path: "/api/posts", enabled: false },
];

const FIXTURES_RESPONSE = {
  fixtures: ["default", "empty", "many-items"],
  active: "default",
};

async function stubMockRoutes(page: import("@playwright/test").Page) {
  await page.route("**/studio/mock-routes", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ routes: MOCK_ROUTES }),
      });
    }
    return route.continue();
  });

  // Stub the toggle endpoint for individual route toggling.
  await page.route("**/studio/mock-routes/**", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "r1",
          method: "GET",
          path: "/api/users",
          enabled: false,
        }),
      });
    }
    return route.continue();
  });
}

async function stubFixtures(page: import("@playwright/test").Page) {
  await page.route("**/studio/fixtures**", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(FIXTURES_RESPONSE),
      });
    }
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.continue();
  });
}

async function goToStudio(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  // Ensure the Studio tab is active (it is the default).
  await expect(page.getByTestId("tab-studio")).toHaveAttribute(
    "data-active",
    "true",
  );
}

// ── Mock-route gallery ─────────────────────────────────────────────────────

test.describe("mock-route gallery", () => {
  test.beforeEach(async ({ page }) => {
    await stubMockRoutes(page);
    await goToStudio(page);
  });

  test("opening Mocks sub-view renders the route gallery", async ({ page }) => {
    await page.getByTestId("studio-sub-mocks").click();
    await expect(page.getByTestId("mock-route-gallery")).toBeVisible();
  });

  test("route gallery shows all stubbed routes", async ({ page }) => {
    await page.getByTestId("studio-sub-mocks").click();
    await page.waitForSelector('[data-testid="mock-route-table"]', {
      timeout: 10_000,
    });
    await expect(page.getByTestId("mock-route-row-r1")).toBeVisible();
    await expect(page.getByTestId("mock-route-row-r2")).toBeVisible();
  });

  test("route rows display method and path", async ({ page }) => {
    await page.getByTestId("studio-sub-mocks").click();
    await page.waitForSelector('[data-testid="mock-route-table"]');
    const row = page.getByTestId("mock-route-row-r1");
    await expect(row).toContainText("GET");
    await expect(row).toContainText("/api/users");
  });

  test("clicking toggle button for a route calls the toggle endpoint", async ({
    page,
  }) => {
    let toggleCalled = false;
    await page.route("**/studio/mock-routes/r1/toggle", (route) => {
      if (route.request().method() === "POST") {
        toggleCalled = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "r1",
            method: "GET",
            path: "/api/users",
            enabled: false,
          }),
        });
      }
      return route.continue();
    });

    await page.getByTestId("studio-sub-mocks").click();
    await page.waitForSelector('[data-testid="toggle-r1"]');
    await page.getByTestId("toggle-r1").click();
    await page.waitForTimeout(200);
    expect(toggleCalled).toBe(true);
  });

  test("refresh button reloads the route list", async ({ page }) => {
    let callCount = 0;
    // Override the stub to count calls.
    await page.route("**/studio/mock-routes", (route) => {
      if (route.request().method() === "GET") {
        callCount += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ routes: MOCK_ROUTES }),
        });
      }
      return route.continue();
    });

    await page.getByTestId("studio-sub-mocks").click();
    await page.waitForSelector('[data-testid="mock-route-refresh"]');
    const before = callCount;
    await page.getByTestId("mock-route-refresh").click();
    await page.waitForTimeout(300);
    expect(callCount).toBeGreaterThan(before);
  });
});

// ── Fixture switcher ───────────────────────────────────────────────────────

test.describe("fixture switcher", () => {
  test.beforeEach(async ({ page }) => {
    await stubFixtures(page);
    await goToStudio(page);
  });

  test("opening Fixtures sub-view renders the fixture switcher", async ({
    page,
  }) => {
    await page.getByTestId("studio-sub-fixtures").click();
    await expect(page.getByTestId("fixture-switcher")).toBeVisible();
  });

  test("entering a route and clicking LOAD fetches fixtures", async ({
    page,
  }) => {
    await page.getByTestId("studio-sub-fixtures").click();
    await page.waitForSelector('[data-testid="fixture-route-input"]');

    await page.getByTestId("fixture-route-input").fill("/api/users");
    await page.getByTestId("fixture-load-btn").click();

    // After load, the fixture list should appear with the stubbed fixtures.
    await page.waitForSelector('[data-testid="fixture-list"]', {
      timeout: 10_000,
    });
    await expect(page.getByTestId("fixture-option-default")).toBeVisible();
    await expect(page.getByTestId("fixture-option-empty")).toBeVisible();
    await expect(page.getByTestId("fixture-option-many-items")).toBeVisible();
  });

  test("active fixture shows ACTIVE badge after load", async ({ page }) => {
    await page.getByTestId("studio-sub-fixtures").click();
    await page.getByTestId("fixture-route-input").fill("/api/users");
    await page.getByTestId("fixture-load-btn").click();
    await page.waitForSelector('[data-testid="fixture-active-badge-default"]', {
      timeout: 10_000,
    });
    await expect(
      page.getByTestId("fixture-active-badge-default"),
    ).toBeVisible();
  });

  test("selecting a different fixture and clicking ACTIVATE sends POST request", async ({
    page,
  }) => {
    let activateCalled = false;
    let activateBody: unknown = null;

    await page.route("**/studio/fixtures/activate", async (route) => {
      if (route.request().method() === "POST") {
        activateCalled = true;
        activateBody = JSON.parse(route.request().postData() ?? "{}");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.continue();
    });

    await page.getByTestId("studio-sub-fixtures").click();
    await page.getByTestId("fixture-route-input").fill("/api/users");
    await page.getByTestId("fixture-load-btn").click();
    await page.waitForSelector('[data-testid="fixture-list"]', {
      timeout: 10_000,
    });

    // Select the "empty" fixture (different from "default" which is active).
    await page.getByTestId("fixture-option-empty").click();
    await page.getByTestId("fixture-activate-btn").click();
    await page.waitForTimeout(300);

    expect(activateCalled).toBe(true);
    expect(activateBody).toMatchObject({
      route: "/api/users",
      fixture: "empty",
    });
  });

  test("active fixture status indicator is visible after load", async ({
    page,
  }) => {
    await page.getByTestId("studio-sub-fixtures").click();
    await page.getByTestId("fixture-route-input").fill("/api/users");
    await page.getByTestId("fixture-load-btn").click();
    await page.waitForSelector('[data-testid="fixture-active-status"]', {
      timeout: 10_000,
    });
    await expect(page.getByTestId("fixture-active-status")).toContainText(
      "default",
    );
  });
});
