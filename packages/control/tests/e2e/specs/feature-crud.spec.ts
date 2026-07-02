/**
 * E2E spec: Create-feature and update-feature flows.
 *
 * Covers the two write paths in the Studio tab feature rail:
 *   POST /studio/issues         (CREATE)
 *   POST /studio/issues/update  (UPDATE)
 *
 * All /studio/issues and /analytics/slots endpoints are stubbed with
 * page.route() — no real database or GitHub credentials required.
 *
 * The update path targets the single feature-update route the sf-serve
 * studio router registers (`POST /studio/issues/update` with
 * `{ id, state?, title? }`, see crates/sf-serve/src/routes/studio.rs). It is
 * keyed on the project-graph node id (a UUID), not the issue number — see
 * packages/control/apps/src/controllers/FeaturePaneController.ts
 * `patchFeature()` (issue #835).
 *
 * Canonical docs:
 *   docs/product.md
 *   docs/ux/studio-ux.md
 *   docs/code-review/test-coverage-2026-05-28.md
 */

import { test, expect } from "../fixtures";

// ── Shared constants ──────────────────────────────────────────────────────────

const EXISTING_ISSUE_NUMBER = 99;
const NEW_ISSUE_NUMBER = 100;
const EXISTING_ISSUE_ID = "11111111-1111-1111-1111-111111111111";

// ── Route stubs ───────────────────────────────────────────────────────────────

/**
 * Stub analytics/slots (empty — no running agents) and a single pre-existing
 * DB issue. The create/patch routes are set up per-test.
 */
async function stubNoSlots(
  page: import("@playwright/test").Page,
  dbIssues: Array<{
    number: number;
    id?: string;
    title: string;
    body?: string;
    status: string;
  }> = [],
): Promise<void> {
  await page.route("**/analytics/slots", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ slots: [] }),
    }),
  );

  await page.route("**/studio/issues**", (route) => {
    const url = route.request().url();
    const method = route.request().method();

    // Individual issue GET (e.g. after patch re-fetch)
    for (const issue of dbIssues) {
      if (url.endsWith(`/studio/issues/${issue.number}`) && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(issue),
        });
      }
    }

    // List
    if (method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ issues: dbIssues }),
      });
    }

    // Fall through — let per-test routes intercept POST /studio/issues
    // (CREATE) and POST /studio/issues/update (UPDATE).
    return route.fallback();
  });
}

// ── Navigation helper ─────────────────────────────────────────────────────────

async function goToStudioFeatures(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.getByTestId("studio-sub-features").click();
  await page.waitForSelector('[data-testid="feature-pane"]', {
    timeout: 10_000,
  });
}

// ── CREATE flow ───────────────────────────────────────────────────────────────

test.describe("CREATE feature flow", () => {
  test("CREATE button is disabled when the input is empty", async ({
    page,
  }) => {
    await stubNoSlots(page);
    await goToStudioFeatures(page);

    const featureList = page.getByTestId("feature-list");
    await expect(featureList).toBeVisible();

    // The ActionForm inside the rail has placeholder "New feature…"
    const createTextarea = featureList.locator(
      'textarea[placeholder="New feature…"]',
    );
    await expect(createTextarea).toBeVisible();

    // The CREATE button is disabled when the textarea is empty.
    const createButton = featureList.locator("button", { hasText: "CREATE" });
    await expect(createButton).toBeDisabled();
  });

  test("submitting CREATE via Enter fires POST /studio/issues with title", async ({
    page,
  }) => {
    await stubNoSlots(page);

    let capturedBody: unknown = null;

    // Intercept the POST before routing — must be registered before goTo
    await page.route("**/studio/issues", async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        capturedBody = JSON.parse(
          (await route.request().postData()) ?? "{}",
        ) as unknown;
        // Return the new issue
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            number: NEW_ISSUE_NUMBER,
            title: "my new feature",
            status: "draft",
          }),
        });
      }
      return route.fallback();
    });

    await goToStudioFeatures(page);

    const featureList = page.getByTestId("feature-list");
    const createTextarea = featureList.locator(
      'textarea[placeholder="New feature…"]',
    );
    await createTextarea.fill("my new feature");

    // Submit via Enter key
    await createTextarea.press("Enter");

    // Wait for the POST to be fired
    await page.waitForTimeout(500);

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as { title?: string };
    expect(body.title).toBe("my new feature");
  });

  test("after successful CREATE the new feature row appears and is auto-selected", async ({
    page,
  }) => {
    // Start with empty list; after POST, re-fetch returns the new issue.
    let issueList: Array<{
      number: number;
      title: string;
      body?: string;
      status: string;
    }> = [];

    await page.route("**/analytics/slots", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ slots: [] }),
      }),
    );

    await page.route("**/studio/issues**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      if (method === "POST" && !url.match(/\/studio\/issues\/\d+/)) {
        const data = JSON.parse((await route.request().postData()) ?? "{}") as {
          title?: string;
        };
        const newIssue = {
          number: NEW_ISSUE_NUMBER,
          title: data.title ?? "untitled",
          status: "draft",
        };
        issueList = [newIssue];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(newIssue),
        });
      }

      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ issues: issueList }),
        });
      }

      return route.fallback();
    });

    await goToStudioFeatures(page);

    const featureList = page.getByTestId("feature-list");
    const createTextarea = featureList.locator(
      'textarea[placeholder="New feature…"]',
    );
    await createTextarea.fill("auto-selected feature");
    await createTextarea.press("Enter");

    // The new row must appear in the rail
    await expect(
      page.getByTestId(`feature-row-${NEW_ISSUE_NUMBER}`),
    ).toBeVisible({ timeout: 5_000 });

    // The detail panel must be visible (auto-selection happened)
    await expect(page.getByTestId("feature-detail")).toBeVisible({
      timeout: 5_000,
    });

    // The detail header must show the new issue number
    await expect(
      page.getByTestId("feature-detail").getByText(`#${NEW_ISSUE_NUMBER}`),
    ).toBeVisible();
  });

  test("Shift+Enter inserts a newline and does not submit the CREATE form", async ({
    page,
  }) => {
    await stubNoSlots(page);

    let postFired = false;
    await page.route("**/studio/issues", async (route) => {
      if (route.request().method() === "POST") {
        postFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            number: NEW_ISSUE_NUMBER,
            title: "test",
            status: "draft",
          }),
        });
      }
      return route.fallback();
    });

    await goToStudioFeatures(page);

    const featureList = page.getByTestId("feature-list");
    const createTextarea = featureList.locator(
      'textarea[placeholder="New feature…"]',
    );
    await createTextarea.fill("line one");

    // Shift+Enter should insert a newline, not submit
    await createTextarea.press("Shift+Enter");

    // Give a moment to make sure no POST was fired
    await page.waitForTimeout(300);

    // The form should not have been submitted
    expect(postFired).toBe(false);

    // Textarea value should contain a newline
    const textareaValue = await createTextarea.inputValue();
    expect(textareaValue).toContain("\n");
  });
});

// ── UPDATE flow ───────────────────────────────────────────────────────────────

test.describe("UPDATE feature flow", () => {
  test("UPDATE form is visible in detail panel when feature has no active session", async ({
    page,
  }) => {
    await stubNoSlots(page, [
      {
        number: EXISTING_ISSUE_NUMBER,
        id: EXISTING_ISSUE_ID,
        title: "existing feature",
        body: "original body",
        status: "draft",
      },
    ]);

    await goToStudioFeatures(page);

    // Select the existing feature
    await page.waitForSelector(
      `[data-testid="feature-row-${EXISTING_ISSUE_NUMBER}"]`,
      { timeout: 10_000 },
    );
    await page.click(`[data-testid="feature-row-${EXISTING_ISSUE_NUMBER}"]`);

    await expect(page.getByTestId("feature-detail")).toBeVisible();

    // The UPDATE form is present when there is no active session (no sessionId)
    const updateTextarea = page
      .getByTestId("feature-detail")
      .locator('textarea[placeholder="Refine the feature spec…"]');
    await expect(updateTextarea).toBeVisible();

    const updateButton = page
      .getByTestId("feature-detail")
      .locator("button", { hasText: "UPDATE" });
    await expect(updateButton).toBeVisible();
  });

  test("submitting UPDATE fires POST /studio/issues/update with the node id and title", async ({
    page,
  }) => {
    await stubNoSlots(page, [
      {
        number: EXISTING_ISSUE_NUMBER,
        id: EXISTING_ISSUE_ID,
        title: "existing feature",
        body: "",
        status: "draft",
      },
    ]);

    let capturedUpdateBody: unknown = null;

    // Intercept the reconciled update route (issue #835): the sf-serve studio
    // router registers exactly one feature-update route,
    // `POST /studio/issues/update { id, state?, title? }`, keyed on the
    // project-graph node id rather than the issue number.
    await page.route("**/studio/issues/update", async (route) => {
      if (route.request().method() === "POST") {
        capturedUpdateBody = JSON.parse(
          (await route.request().postData()) ?? "{}",
        ) as unknown;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            number: EXISTING_ISSUE_NUMBER,
            title: "existing feature",
            body: "updated body text",
            status: "draft",
          }),
        });
      }
      return route.fallback();
    });

    await goToStudioFeatures(page);

    await page.waitForSelector(
      `[data-testid="feature-row-${EXISTING_ISSUE_NUMBER}"]`,
      { timeout: 10_000 },
    );
    await page.click(`[data-testid="feature-row-${EXISTING_ISSUE_NUMBER}"]`);

    await expect(page.getByTestId("feature-detail")).toBeVisible();

    const updateTextarea = page
      .getByTestId("feature-detail")
      .locator('textarea[placeholder="Refine the feature spec…"]');
    await updateTextarea.fill("updated body text");

    // Submit via the UPDATE button
    const updateButton = page
      .getByTestId("feature-detail")
      .locator("button", { hasText: "UPDATE" });
    await updateButton.click();

    // Wait for the POST to be fired
    await page.waitForTimeout(500);

    expect(capturedUpdateBody).not.toBeNull();
    const body = capturedUpdateBody as { id?: string; title?: string };
    expect(body.id).toBe(EXISTING_ISSUE_ID);
    expect(body.title).toBe("updated body text");
  });

  test("after UPDATE the DESCRIPTION section re-renders with the new body", async ({
    page,
  }) => {
    // Use a task-list body so the rendered DESCRIPTION changes visibly after
    // the update — prose-only bodies render as "No checklist items"
    // regardless of content, making old/new states indistinguishable.
    const updatedBody = "- [ ] refreshed task item";
    const updatedBodyText = "refreshed task item";

    // After the update, the re-fetch returns the updated body.
    let issueBody = "original body";

    await page.route("**/analytics/slots", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ slots: [] }),
      }),
    );

    await page.route("**/studio/issues**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      // Reconciled update route (issue #835): `POST /studio/issues/update
      // { id, title }`, keyed on the project-graph node id.
      if (method === "POST" && url.endsWith("/studio/issues/update")) {
        const data = JSON.parse((await route.request().postData()) ?? "{}") as {
          id?: string;
          title?: string;
        };
        issueBody = data.title ?? issueBody;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            number: EXISTING_ISSUE_NUMBER,
            title: "existing feature",
            body: issueBody,
            status: "draft",
          }),
        });
      }

      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            issues: [
              {
                number: EXISTING_ISSUE_NUMBER,
                id: EXISTING_ISSUE_ID,
                title: "existing feature",
                body: issueBody,
                status: "draft",
              },
            ],
          }),
        });
      }

      return route.fallback();
    });

    await goToStudioFeatures(page);

    await page.waitForSelector(
      `[data-testid="feature-row-${EXISTING_ISSUE_NUMBER}"]`,
      { timeout: 10_000 },
    );
    await page.click(`[data-testid="feature-row-${EXISTING_ISSUE_NUMBER}"]`);

    await expect(page.getByTestId("feature-detail")).toBeVisible();

    const updateTextarea = page
      .getByTestId("feature-detail")
      .locator('textarea[placeholder="Refine the feature spec…"]');
    await updateTextarea.fill(updatedBody);

    const updateButton = page
      .getByTestId("feature-detail")
      .locator("button", { hasText: "UPDATE" });
    await updateButton.click();

    // After the update + re-fetch, the DESCRIPTION section must show the new
    // body. The updated body contains a task-list item so the checklist renders
    // its text rather than the "No checklist items" prose placeholder.
    await expect(page.getByTestId("feature-detail")).toContainText(
      updatedBodyText,
      { timeout: 5_000 },
    );
  });

  test("Shift+Enter inserts a newline and does not submit the UPDATE form", async ({
    page,
  }) => {
    await stubNoSlots(page, [
      {
        number: EXISTING_ISSUE_NUMBER,
        id: EXISTING_ISSUE_ID,
        title: "existing feature",
        body: "",
        status: "draft",
      },
    ]);

    let updatePostFired = false;
    await page.route("**/studio/issues/update", async (route) => {
      if (route.request().method() === "POST") {
        updatePostFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            number: EXISTING_ISSUE_NUMBER,
            title: "existing feature",
            body: "line one\n",
            status: "draft",
          }),
        });
      }
      return route.fallback();
    });

    await goToStudioFeatures(page);

    await page.waitForSelector(
      `[data-testid="feature-row-${EXISTING_ISSUE_NUMBER}"]`,
      { timeout: 10_000 },
    );
    await page.click(`[data-testid="feature-row-${EXISTING_ISSUE_NUMBER}"]`);

    await expect(page.getByTestId("feature-detail")).toBeVisible();

    const updateTextarea = page
      .getByTestId("feature-detail")
      .locator('textarea[placeholder="Refine the feature spec…"]');
    await updateTextarea.fill("line one");

    // Shift+Enter should insert a newline, not submit
    await updateTextarea.press("Shift+Enter");

    // Give a moment to confirm no update POST was fired
    await page.waitForTimeout(300);

    expect(updatePostFired).toBe(false);

    // The textarea value should contain a newline
    const textareaValue = await updateTextarea.inputValue();
    expect(textareaValue).toContain("\n");
  });
});
