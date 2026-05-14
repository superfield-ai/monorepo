/**
 * E2E spec: SSE-streamed data feeds produce visible DOM changes in the browser.
 *
 * Covers three feeds:
 *   Log tail      (/orchestrator/logs)     — scenarios 1–3
 *   Cluster events (/studio/cluster/events) — scenarios 4–5
 *   CI check-runs (/analytics/check-runs/stream) — scenarios 6–7
 *
 * All scenarios use `page.addInitScript()` to replace `EventSource` with a
 * controllable mock so events can be injected synchronously in the test body.
 *
 * Canonical docs: docs/product.md §Agent monitoring — Dev-loop log tail;
 * CI status feed
 */

import { test, expect } from "../fixtures";

// ── Shared helpers ─────────────────────────────────────────────────────────────

/** Install a controllable EventSource mock before the page loads.
 *
 * The mock exposes `window.__mockEventSources` — a Map<url-substring, instance>
 * — so test code can retrieve the mock and fire events after page load.
 */
function installMockEventSource(page: import("@playwright/test").Page): void {
  page.addInitScript(() => {
    type Listener = (event: MessageEvent<string>) => void;

    class MockEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;

      readonly url: string;
      readyState = MockEventSource.OPEN;
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
      onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null =
        null;
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null;

      private readonly _listeners = new Map<string, Set<Listener>>();

      constructor(url: string) {
        this.url = url;
        // Register on the global registry so tests can look up the instance.
        const registry = (
          globalThis as unknown as {
            __mockEventSources: Map<string, MockEventSource>;
          }
        ).__mockEventSources;
        registry.set(url, this);
      }

      addEventListener(type: string, listener: EventListener): void {
        const set = this._listeners.get(type) ?? new Set<Listener>();
        set.add(listener as Listener);
        this._listeners.set(type, set);
      }

      removeEventListener(type: string, listener: EventListener): void {
        this._listeners.get(type)?.delete(listener as Listener);
      }

      dispatchEvent(): boolean {
        return true;
      }

      /** Test helper — fire a named SSE event with a data payload. */
      emit(type: string, data: string): void {
        const event = new MessageEvent(type, { data });
        const listeners = this._listeners.get(type);
        if (listeners) {
          for (const fn of listeners) fn(event as MessageEvent<string>);
        }
        // Also trigger onmessage for generic "message" events.
        if (type === "message" && this.onmessage) {
          this.onmessage.call(
            this as unknown as EventSource,
            event as MessageEvent,
          );
        }
      }

      close(): void {
        this.readyState = MockEventSource.CLOSED;
      }
    }

    // Initialise the registry before any EventSource is created.
    (
      globalThis as unknown as {
        __mockEventSources: Map<string, MockEventSource>;
      }
    ).__mockEventSources = new Map();

    (
      window as typeof window & { EventSource: typeof EventSource }
    ).EventSource = MockEventSource as unknown as typeof EventSource;
  });
}

/** Navigate to the app root and open the Orchestrator tab. */
async function goToOrchestratorTab(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-orchestrator"]');
  await page.waitForSelector('[data-testid="orchestrator-tab-content"]', {
    timeout: 10_000,
  });
}

/** Stub the orchestrator status endpoint. */
async function stubOrchestratorStatus(
  page: import("@playwright/test").Page,
  processState: "stopped" | "running" = "running",
): Promise<void> {
  await page.route("**/orchestrator/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        process: processState,
        pid: processState === "running" ? 1234 : null,
        apiReachable: processState === "running",
        uptimeMs: processState === "running" ? 60_000 : 0,
      }),
    }),
  );
}

/** Stub analytics/loops with empty healthy state. */
async function stubLoops(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/analytics/loops", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ loops: {} }),
    }),
  );
}

/** Stub analytics/slots to return an empty list. */
async function stubSlotsEmpty(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.route("**/analytics/slots", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ slots: [] }),
    }),
  );
}

// ── Log tail (scenarios 1–3) ───────────────────────────────────────────────────

test.describe("Log tail SSE feed", () => {
  // ── Scenario 1: Log pane becomes visible in the Orchestrator view ─────────

  test("log pane is visible in the Orchestrator view", async ({ page }) => {
    installMockEventSource(page);
    await stubOrchestratorStatus(page, "running");
    await stubLoops(page);
    await stubSlotsEmpty(page);

    await goToOrchestratorTab(page);

    const logPane = page.locator('[data-testid="log-pane"]');
    await expect(logPane).toBeVisible({ timeout: 10_000 });
  });

  // ── Scenario 2: A log-line SSE event appends a new row ────────────────────

  test("a log-line SSE event appends a new row to the log pane", async ({
    page,
  }) => {
    installMockEventSource(page);
    await stubOrchestratorStatus(page, "running");
    await stubLoops(page);
    await stubSlotsEmpty(page);

    await goToOrchestratorTab(page);

    const logPane = page.locator('[data-testid="log-pane"]');
    await expect(logPane).toBeVisible({ timeout: 10_000 });

    // Fire a log line via the mock EventSource.
    await page.evaluate(() => {
      const registry = (
        globalThis as unknown as {
          __mockEventSources: Map<
            string,
            { emit(type: string, data: string): void; url: string }
          >;
        }
      ).__mockEventSources;

      // Find the logs EventSource (URL contains /orchestrator/logs).
      for (const [url, source] of registry) {
        if (url.includes("/orchestrator/logs")) {
          source.emit("message", "[info] bootstrap complete");
          return;
        }
      }
      // If no SSE connection found yet, schedule for after mount.
      // The controller connects on start(); the message type is "message" for logs.
      throw new Error(
        "No /orchestrator/logs EventSource found in registry. " +
          "Available: " +
          Array.from(registry.keys()).join(", "),
      );
    });

    // The log pane should now contain the injected log line.
    await expect(logPane).toContainText("[info] bootstrap complete", {
      timeout: 5_000,
    });
  });

  // ── Scenario 3: Auto-scroll — pane scrolls to bottom as new lines arrive ──

  test("log pane auto-scrolls to the bottom as new lines arrive", async ({
    page,
  }) => {
    installMockEventSource(page);
    await stubOrchestratorStatus(page, "running");
    await stubLoops(page);
    await stubSlotsEmpty(page);

    await goToOrchestratorTab(page);

    const logPane = page.locator('[data-testid="log-pane"]');
    await expect(logPane).toBeVisible({ timeout: 10_000 });

    // Inject many log lines to trigger auto-scroll.
    await page.evaluate(() => {
      const registry = (
        globalThis as unknown as {
          __mockEventSources: Map<
            string,
            { emit(type: string, data: string): void; url: string }
          >;
        }
      ).__mockEventSources;

      for (const [url, source] of registry) {
        if (url.includes("/orchestrator/logs")) {
          // Fire 30 lines so there is definitely overflow to scroll.
          for (let i = 0; i < 30; i++) {
            source.emit("message", `[info] line ${i} — auto-scroll payload`);
          }
          return;
        }
      }
      throw new Error("No /orchestrator/logs EventSource found");
    });

    // Last line should be visible (scrolled into view).
    await expect(logPane).toContainText("line 29 — auto-scroll payload", {
      timeout: 5_000,
    });

    // Verify the scroll sentinel (logEndRef div) is at or near the bottom of
    // the pane's scrollable area.
    const isScrolledToBottom = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="log-pane"]');
      if (!pane) return false;
      // The inner scrollable div is the second child (after the header row).
      const scrollable = pane.querySelector(
        'div[style*="overflow: auto"], div[style*="overflow:auto"]',
      ) as HTMLElement | null;
      if (!scrollable) {
        // Fall back to the pane itself.
        return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 10;
      }
      return (
        scrollable.scrollHeight -
          scrollable.scrollTop -
          scrollable.clientHeight <
        10
      );
    });

    // The auto-scroll may have fired via smooth behaviour; a pixel tolerance of
    // 10 px is sufficient to detect that we are at the bottom.
    expect(isScrolledToBottom).toBe(true);
  });
});

// ── Cluster events (scenarios 4–5) ────────────────────────────────────────────

test.describe("Cluster events SSE feed", () => {
  // ── Scenario 4: cluster-status "degraded" fires IframeOverlay ─────────────
  //
  // Note: this scenario already exists in error-handling.spec.ts under
  // "cluster-down status surfaces the IframeOverlay". That test covers the SSE
  // path (the mock EventSource emits the event before the route handler
  // returns). We add a dedicated scenario here with the full MockEventSource
  // pattern for completeness and to verify the SSE-→-DOM flow explicitly.

  test('cluster-status "degraded" SSE event shows the IframeOverlay', async ({
    page,
  }) => {
    installMockEventSource(page);

    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    await page.click('[data-testid="tab-viewport"]');

    // Fire the cluster-status: degraded event via the mock.
    await page.evaluate(() => {
      const registry = (
        globalThis as unknown as {
          __mockEventSources: Map<
            string,
            { emit(type: string, data: string): void; url: string }
          >;
        }
      ).__mockEventSources;

      for (const [url, source] of registry) {
        if (url.includes("/studio/cluster/events")) {
          source.emit("cluster-status", JSON.stringify({ status: "degraded" }));
          return;
        }
      }
      throw new Error("No /studio/cluster/events EventSource found");
    });

    const overlay = page.locator('[data-testid="iframe-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    await expect(overlay).toHaveAttribute("data-mode", "cluster-down");
  });

  // ── Scenario 5: cluster-status "healthy" after "degraded" removes overlay ─

  test('cluster-status "healthy" SSE event after "degraded" removes the overlay', async ({
    page,
  }) => {
    installMockEventSource(page);

    await page.goto("/");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    await page.click('[data-testid="tab-viewport"]');

    // First fire degraded to show the overlay.
    await page.evaluate(() => {
      const registry = (
        globalThis as unknown as {
          __mockEventSources: Map<
            string,
            { emit(type: string, data: string): void; url: string }
          >;
        }
      ).__mockEventSources;

      for (const [url, source] of registry) {
        if (url.includes("/studio/cluster/events")) {
          source.emit("cluster-status", JSON.stringify({ status: "degraded" }));
          return;
        }
      }
      throw new Error("No /studio/cluster/events EventSource found");
    });

    const overlay = page.locator('[data-testid="iframe-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 10_000 });

    // Now fire healthy to remove the overlay.
    await page.evaluate(() => {
      const registry = (
        globalThis as unknown as {
          __mockEventSources: Map<
            string,
            { emit(type: string, data: string): void; url: string }
          >;
        }
      ).__mockEventSources;

      for (const [url, source] of registry) {
        if (url.includes("/studio/cluster/events")) {
          source.emit("cluster-status", JSON.stringify({ status: "healthy" }));
          return;
        }
      }
      throw new Error("No /studio/cluster/events EventSource found");
    });

    await expect(overlay).not.toBeVisible({ timeout: 10_000 });
  });
});

// ── CI check-run feed (scenarios 6–7) ─────────────────────────────────────────

test.describe("CI check-run SSE feed", () => {
  // ── Scenario 6: check-run failure event renders row with Escalate button ──

  test('check-run SSE event with conclusion "failure" renders a row with an Escalate button', async ({
    page,
  }) => {
    installMockEventSource(page);
    await stubOrchestratorStatus(page, "running");
    await stubLoops(page);
    await stubSlotsEmpty(page);

    await goToOrchestratorTab(page);

    const feedSection = page.locator('[data-testid="ci-status-feed-section"]');
    await expect(feedSection).toBeVisible({ timeout: 10_000 });

    // Inject a failed check-run event.
    const sha = "abc1234def5678901234567890123456789012ab";
    const checkRunName = "build-and-test";
    const rowKey = `${sha}:${checkRunName}`;

    await page.evaluate(
      ({ sha, checkRunName }) => {
        const registry = (
          globalThis as unknown as {
            __mockEventSources: Map<
              string,
              { emit(type: string, data: string): void; url: string }
            >;
          }
        ).__mockEventSources;

        for (const [url, source] of registry) {
          if (url.includes("/analytics/check-runs")) {
            source.emit(
              "message",
              JSON.stringify({
                sha,
                checkRun: {
                  id: 1,
                  name: checkRunName,
                  status: "completed",
                  conclusion: "failure",
                  startedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                  detailsUrl: "",
                },
                ts: Date.now(),
              }),
            );
            return;
          }
        }
        throw new Error("No /analytics/check-runs EventSource found");
      },
      { sha, checkRunName },
    );

    // The CI row should appear.
    const ciRow = page.locator(`[data-testid="ci-row-${rowKey}"]`);
    await expect(ciRow).toBeVisible({ timeout: 5_000 });

    // The Escalate button must be present on a failed row.
    const escalateBtn = page.locator(`[data-testid="escalate-btn-${rowKey}"]`);
    await expect(escalateBtn).toBeVisible();
    await expect(escalateBtn).toHaveText(/escalate/i);
  });

  // ── Scenario 7: Clicking Escalate button dispatches the escalate action ───

  test("clicking the Escalate button dispatches the escalate action", async ({
    page,
  }) => {
    installMockEventSource(page);
    await stubOrchestratorStatus(page, "running");
    await stubLoops(page);
    await stubSlotsEmpty(page);

    // Stub the escalate endpoint.
    let escalateCalled = false;
    let escalateBody: unknown = null;
    await page.route("**/steer/escalate", async (route) => {
      escalateCalled = true;
      escalateBody = JSON.parse(
        (route.request().postData() as string | null) ?? "{}",
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, issueUrl: null }),
      });
    });

    await goToOrchestratorTab(page);

    const feedSection = page.locator('[data-testid="ci-status-feed-section"]');
    await expect(feedSection).toBeVisible({ timeout: 10_000 });

    const sha = "deadbeef1234567890abcdef1234567890abcdef";
    const checkRunName = "lint";
    const rowKey = `${sha}:${checkRunName}`;

    // Inject failed check-run event.
    await page.evaluate(
      ({ sha, checkRunName }) => {
        const registry = (
          globalThis as unknown as {
            __mockEventSources: Map<
              string,
              { emit(type: string, data: string): void; url: string }
            >;
          }
        ).__mockEventSources;

        for (const [url, source] of registry) {
          if (url.includes("/analytics/check-runs")) {
            source.emit(
              "message",
              JSON.stringify({
                sha,
                checkRun: {
                  id: 2,
                  name: checkRunName,
                  status: "completed",
                  conclusion: "failure",
                  startedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                  detailsUrl: "",
                },
                ts: Date.now(),
              }),
            );
            return;
          }
        }
        throw new Error("No /analytics/check-runs EventSource found");
      },
      { sha, checkRunName },
    );

    const escalateBtn = page.locator(`[data-testid="escalate-btn-${rowKey}"]`);
    await expect(escalateBtn).toBeVisible({ timeout: 5_000 });
    await escalateBtn.click();

    // Wait for the POST to go through.
    await page.waitForTimeout(500);
    expect(escalateCalled).toBe(true);
    expect((escalateBody as Record<string, unknown>)?.checkRunName).toBe(
      checkRunName,
    );
    expect((escalateBody as Record<string, unknown>)?.sha).toBe(sha);
  });
});
