/**
 * template-pages-coverage (control × template integration)
 *
 * Walks every top-level tab of the studio control UI and asserts:
 *   1. The tab's active-state attribute flips to true on click.
 *   2. No <ErrorBoundary> fallback ("error-boundary-card") is shown after
 *      switching — i.e. the underlying view actually rendered.
 *
 * Anchor-element assertions per tab were avoided because each view's content
 * depends on cluster/API reachability, which is intentionally absent in the
 * smoke environment. The auto-running `capturedConsole` fixture (see
 * ../fixtures.ts) enforces zero JS console errors across the run.
 *
 * Spec: cli/docs/control-template-integration.md §2.3.
 */
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const PASSWORD = "pages-password-123";
const TAB_TESTIDS: readonly string[] = [
  "tab-studio",
  "tab-orchestrator",
  "tab-preview",
  "tab-deploy",
];

// Playwright's APIRequestContext doesn't always pick up `use.baseURL` for
// relative request URLs in this test setup, so resolve the base from the
// same env contract the playwright config uses.
const BASE_URL = `http://127.0.0.1:${process.env.CONTROL_E2E_PORT ?? "7009"}`;

function freshUsername(suffix: string): string {
  return `e2e-pages-${suffix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function authenticate(
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
  username: string,
): Promise<void> {
  const reg = await request.post(`${BASE_URL}/api/auth/register`, {
    data: { username, password: PASSWORD },
  });
  expect(reg.status(), await reg.text()).toBe(201);

  const state = await request.storageState();
  const authCookie = state.cookies.find((c) => c.name === "superfield_auth");
  if (!authCookie)
    throw new Error("missing superfield_auth cookie after register");
  await context.addCookies([
    {
      name: authCookie.name,
      value: authCookie.value,
      domain: authCookie.domain,
      path: authCookie.path,
      httpOnly: authCookie.httpOnly,
      secure: authCookie.secure,
      sameSite: authCookie.sameSite,
      expires: authCookie.expires,
    },
  ]);
}

// Skip when SUPERFIELD_REPO_ROOT is unset — only the dedicated
// ci-control-template workflow provides a template fixture; the default
// Control browser E2E tests job does not.
const describeFn = process.env.SUPERFIELD_REPO_ROOT
  ? test.describe
  : test.describe.skip;
describeFn("template pages coverage", () => {
  test("every top-level tab activates and renders without ErrorBoundary fallback", async ({
    page,
    context,
    request,
  }) => {
    await authenticate(page, request, context, freshUsername("walk"));
    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    // The cluster-down IframeOverlay (E14) renders absolutely-positioned over
    // tab buttons and intercepts both real and force-clicks. We're verifying
    // tab navigation, not pointer occlusion — hide it via CSS for the test.
    await page.addStyleTag({
      content: '[data-testid="iframe-overlay"]{display:none!important;}',
    });

    for (const id of TAB_TESTIDS) {
      await page.getByTestId(id).click();
      await expect(
        page.getByTestId(id),
        `${id} should report data-active="true" after click`,
      ).toHaveAttribute("data-active", "true", { timeout: 5_000 });
      // ErrorBoundary fallback would replace the tab's content — assert it
      // is not shown after the tab settles.
      await expect(
        page.locator('[data-testid="error-boundary-card"]'),
        `${id} should not render an ErrorBoundary fallback`,
      ).toHaveCount(0);
    }
  });

  test("debug tab opens the debug view", async ({ page, context, request }) => {
    await authenticate(page, request, context, freshUsername("debug"));
    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    await page.addStyleTag({
      content: '[data-testid="iframe-overlay"]{display:none!important;}',
    });
    await page.getByTestId("debug-badge").click();
    await expect(page.getByTestId("debug-view")).toBeVisible({
      timeout: 10_000,
    });
  });
});
