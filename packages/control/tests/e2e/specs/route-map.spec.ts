/**
 * E2E spec: RouteMap (D2 / C-9.1).
 *
 * Asserts the route sidebar renders fixture entries and clicking a route
 * updates the iframe src. Uses page.route() to stub /studio/demo/routes so
 * the test does not depend on a freshly seeded .studio/demo/routes.json.
 */

import { test, expect } from "../fixtures";

test("clicking a route updates the iframe src", async ({ page }) => {
  await page.route("**/studio/demo/routes", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        routes: [
          { path: "/", title: "Landing", description: "" },
          { path: "/dashboard", title: "Dashboard", description: "" },
        ],
      }),
    });
  });

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await expect(page.getByTestId("route-map")).toBeVisible();
  await expect(page.getByTestId("route-item-/dashboard")).toBeVisible();

  await page.click('[data-testid="route-item-/dashboard"]');
  const iframe = page.getByTestId("app-iframe");
  await expect(iframe).toHaveAttribute("src", /\/app\/dashboard$/);
});
