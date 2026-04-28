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

// We hit the studio server with plain `fetch` rather than Playwright's
// APIRequestContext: the latter races against the `capturedConsole`
// auto-fixture teardown in this test (the response arrives, but the
// pw:api span never resolves before the page closes, surfacing a
// confusing "Target page, context or browser has been closed" error).
const BASE_URL = `http://127.0.0.1:${process.env.CONTROL_E2E_PORT ?? "7009"}`;

interface RegisterResult {
  status: number;
  body: { id: string; username: string };
  setCookie: string | null;
}

async function register(
  username: string,
  password: string,
): Promise<RegisterResult> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let body: { id: string; username: string };
  try {
    body = JSON.parse(text) as { id: string; username: string };
  } catch {
    throw new Error(
      `register: non-JSON response (status ${res.status}): ${text}`,
    );
  }
  return {
    status: res.status,
    body,
    setCookie: res.headers.get("set-cookie"),
  };
}

function parseAuthCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  return match?.[1] ?? null;
}

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

  test("registration succeeds via /api/auth/register", async () => {
    const reg = await register(USERNAME, PASSWORD);
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect(reg.body.username).toBe(USERNAME);
    expect(reg.body.id).toMatch(/^user_/);
    expect(
      parseAuthCookie(reg.setCookie),
      "expected superfield_auth cookie in Set-Cookie header",
    ).toBeTruthy();
  });

  test("authed studio view renders after registration", async ({
    page,
    context,
  }) => {
    // Register over plain HTTP, then plant the auth cookie in the browser
    // context so the page navigation is authenticated.
    const reg = await register(`${USERNAME}-page`, PASSWORD);
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);

    const cookieValue = parseAuthCookie(reg.setCookie);
    expect(cookieValue, "missing superfield_auth cookie").toBeTruthy();
    if (cookieValue) {
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

    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    // Studio tab is the default authed view; chat panel proves it mounted.
    await expect(page.getByTestId("chat-panel")).toBeVisible();
  });
});
