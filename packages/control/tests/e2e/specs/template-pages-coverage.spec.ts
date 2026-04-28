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
import type { BrowserContext } from "@playwright/test";
import { test, expect } from "../fixtures";

const PASSWORD = "pages-password-123";
const TAB_TESTIDS: readonly string[] = ["tab-studio", "tab-viewport"];

// We hit the studio server with plain `fetch` rather than Playwright's
// APIRequestContext: the latter races against the `capturedConsole`
// auto-fixture teardown in this test (the response arrives, but the
// pw:api span never resolves before the page closes, surfacing a
// confusing "Target page, context or browser has been closed" error).
const BASE_URL = `http://127.0.0.1:${process.env.CONTROL_E2E_PORT ?? "7009"}`;

function freshUsername(suffix: string): string {
  return `e2e-pages-${suffix}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseAuthCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  return match?.[1] ?? null;
}

async function authenticate(
  context: BrowserContext,
  username: string,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const body = await res.text();
  if (res.status !== 201) {
    throw new Error(`register failed (status ${res.status}): ${body}`);
  }
  const cookieValue = parseAuthCookie(res.headers.get("set-cookie"));
  if (!cookieValue) {
    throw new Error("missing superfield_auth cookie after register");
  }
  await context.addCookies([
    {
      name: "superfield_auth",
      value: cookieValue,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
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
  }) => {
    await authenticate(context, freshUsername("walk"));
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

  test("debug tab opens the debug view", async ({ page, context }) => {
    await authenticate(context, freshUsername("debug"));
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
