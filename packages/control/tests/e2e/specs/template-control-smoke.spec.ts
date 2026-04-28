/**
 * template-control-smoke (control × template integration #11)
 *
 * Smoke check for the studio server when launched against the template repo
 * (SUPERFIELD_REPO_ROOT=/home/lucas/superfield/template). Asserts:
 *
 *   1. Browser UI loads (root SPA mounts, tab bar visible).
 *   2. No JS console errors / warnings during the run — enforced by the
 *      `capturedConsole` fixture in `../fixtures.ts`.
 *   3. Registration via POST /api/auth/register succeeds and an authed studio
 *      view (the Studio tab chat panel) renders with the session cookie.
 *
 * The studio server is spawned by `tests/e2e/global-setup.ts`. Its child env
 * inherits `process.env`, so passing `SUPERFIELD_REPO_ROOT=...` to the
 * playwright invocation propagates to the studio server without touching the
 * setup file.
 *
 * Spec: cli/docs/control-template-integration.md §2.3 #11.
 */
import { test, expect } from "../fixtures";

const RAND = Math.random().toString(36).slice(2, 10);
const USERNAME = `e2e-smoke-${RAND}`;
const PASSWORD = "smoke-password-123";

// Playwright's APIRequestContext doesn't always pick up `use.baseURL` for
// relative request URLs in this test setup, so resolve the base from the
// same env contract the playwright config uses.
const BASE_URL = `http://127.0.0.1:${process.env.CONTROL_E2E_PORT ?? "7009"}`;

// Requires SUPERFIELD_REPO_ROOT to point at a real template checkout. The
// dedicated ci-control-template workflow sets this; the default control
// e2e job does not, so skip there.
const describeFn = process.env.SUPERFIELD_REPO_ROOT
  ? test.describe
  : test.describe.skip;
describeFn("template control smoke", () => {
  test("browser UI loads without console errors", async ({ page }) => {
    await page.goto("/");
    // Root SPA mount signal — same selector existing specs rely on.
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    await expect(page.getByTestId("tab-bar")).toBeVisible();
    // Console-error / warning assertion is performed by the auto-running
    // `capturedConsole` fixture during teardown.
  });

  test("registration succeeds via /api/auth/register", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/auth/register`, {
      data: { username: USERNAME, password: PASSWORD },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { id: string; username: string };
    expect(body.username).toBe(USERNAME);
    expect(body.id).toMatch(/^user_/);
    // The Set-Cookie header is HttpOnly so we cannot inspect it via JS, but
    // Playwright's APIRequestContext stores it in a shared cookie jar.
    const cookies = await request.storageState();
    const auth = cookies.cookies.find((c) => c.name === "superfield_auth");
    expect(auth, "expected superfield_auth cookie after register").toBeTruthy();
  });

  test("authed studio view renders after registration", async ({
    page,
    context,
    request,
  }) => {
    // Register through the request fixture, then transfer the cookie into the
    // browser context so the page navigation is authenticated.
    const reg = await request.post(`${BASE_URL}/api/auth/register`, {
      data: { username: `${USERNAME}-page`, password: PASSWORD },
    });
    expect(reg.status(), await reg.text()).toBe(201);

    const apiState = await request.storageState();
    const authCookie = apiState.cookies.find(
      (c) => c.name === "superfield_auth",
    );
    if (authCookie) {
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

    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    // Studio tab is the default authed view; chat panel proves it mounted.
    await expect(page.getByTestId("chat-panel")).toBeVisible();
  });
});
