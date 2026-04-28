/**
 * E2E spec: turn timeline + prompt inspector (D6 / C-9.6).
 *
 * Stubs the GET /studio/turns/:sessionId endpoint and the orchestrator
 * status feed (so a slot card with a known sessionId renders) — then
 * asserts the timeline + modal flow behind the Orchestrator tab.
 */

import { test, expect } from "../fixtures";

const SESSION_ID = "demo-session-1";

test("turn timeline renders inside slot card and opens prompt modal", async ({
  page,
}) => {
  await page.route("**/studio/turns/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: SESSION_ID,
        turns: [
          {
            ts: "2026-04-26T01:00:00Z",
            durationMs: 4000,
            tokens: 0,
            costUsd: 0,
            exitStatus: "ok",
            prompt: "Add a discount-code input on /checkout.",
            response: "Done.",
            filesChanged: ["app/checkout/discount.tsx"],
            servicesRestarted: ["web"],
          },
        ],
      }),
    });
  });

  // Stub orchestrator status so OrchestratorView shows a running process.
  await page.route("**/orchestrator/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        process: "running",
        pid: 1,
        apiReachable: true,
        uptimeMs: 1000,
      }),
    });
  });

  // Slots come from /analytics/slots, not from /orchestrator/status.
  await page.route("**/analytics/slots", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        slots: [
          {
            slot: 0,
            issueNumber: 301,
            role: "dev",
            backend: "claude",
            model: "opus",
            elapsedMs: 12000,
            heartbeatAt: Date.now(),
            sessionId: SESSION_ID,
            startedAt: new Date().toISOString(),
          },
        ],
      }),
    });
  });

  await page.route("**/analytics/loops", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ loops: {} }),
    });
  });

  await page.goto("/");
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.click('[data-testid="tab-orchestrator"]');

  const timeline = page.getByTestId(`turn-timeline-${SESSION_ID}`);
  await expect(timeline).toBeVisible();
  await page.click(`[data-testid="turn-row-${SESSION_ID}-0"]`);
  await expect(page.getByTestId("turn-modal")).toBeVisible();
  await page.click('[data-testid="turn-modal-close"]');
});
