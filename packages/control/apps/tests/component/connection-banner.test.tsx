/**
 * Component tests for ConnectionBanner (E10).
 *
 * Covers:
 *  - Renders nothing when /orchestrator/status is reachable
 *  - Renders banner + Start + Retry buttons when status fetch fails
 *  - Clicking "Start dev loop" POSTs to /orchestrator/start and re-polls
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConnectionBanner } from "../../src/components/ConnectionBanner";
import { debugStore } from "../../src/lib/debug-store";
import { toastStore } from "../../src/lib/toast-store";

let originalFetch: typeof fetch;

beforeEach(() => {
  debugStore.__resetForTest();
  toastStore.__resetForTest();
  originalFetch = window.fetch;
});

afterEach(() => {
  window.fetch = originalFetch;
  vi.restoreAllMocks();
});

test("renders nothing when /orchestrator/status returns 200", async () => {
  window.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ process: "running", apiReachable: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  const { container } = render(
    <ConnectionBanner pollIntervalMs={60_000} />,
  );

  // Wait for the initial poll to resolve.
  await new Promise((r) => setTimeout(r, 50));

  expect(container.querySelector('[data-testid="connection-banner"]')).toBeNull();
});

test("renders banner with Start + Retry when status fetch fails", async () => {
  window.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

  const screen = render(<ConnectionBanner pollIntervalMs={60_000} />);

  await expect
    .element(screen.getByTestId("connection-banner"))
    .toBeVisible();
  await expect
    .element(screen.getByTestId("connection-banner-start"))
    .toBeVisible();
  await expect
    .element(screen.getByTestId("connection-banner-retry"))
    .toBeVisible();
});

test("Start dev loop button POSTs to /orchestrator/start", async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ process: "starting", apiReachable: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  window.fetch = fetchMock as unknown as typeof fetch;

  const screen = render(<ConnectionBanner pollIntervalMs={60_000} />);

  await screen.getByTestId("connection-banner-start").click();

  // Wait for the POST + re-poll round-trip.
  await new Promise((r) => setTimeout(r, 100));

  const startCall = fetchMock.mock.calls.find(
    (c) => typeof c[0] === "string" && c[0] === "/orchestrator/start",
  );
  expect(startCall).toBeDefined();
  expect((startCall![1] as RequestInit).method).toBe("POST");
});
