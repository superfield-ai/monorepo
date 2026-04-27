/**
 * Component tests for OAuthPanel — Layer 2.
 *
 * Covers:
 *  - Shows 'not connected' state when status is disconnected
 *  - Initiate button calls controller.initiateOAuth()
 *  - Displays authorization URL from pending state
 *  - Code input calls controller.completeOAuth(code)
 *  - Shows connected state
 *  - Shows error message from error state
 *
 * All tests inject a mock OAuthController as a prop — no real fetch calls
 * are made. The mock objects satisfy the controller's subscribe/getState/
 * action interface without connecting to any network endpoint.
 *
 * Canonical docs: test-plan.md §Layer 2 / OAuthPanel.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { OAuthPanel } from "../../src/components/OAuthPanel";
import type {
  OAuthController,
  OAuthControllerState,
} from "../../src/controllers/OAuthController";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock controller factory
// ---------------------------------------------------------------------------

function makeOAuthControllerMock(
  initialState: Partial<OAuthControllerState> = {},
): {
  controller: OAuthController;
  setState: (partial: Partial<OAuthControllerState>) => void;
} {
  const defaultState: OAuthControllerState = {
    status: "disconnected",
    oauthUrl: null,
    error: null,
    loading: false,
    ...initialState,
  };

  let currentState = { ...defaultState };
  const listeners = new Set<(state: OAuthControllerState) => void>();

  function notify() {
    const snap = { ...currentState };
    for (const l of listeners) l(snap);
  }

  function setState(partial: Partial<OAuthControllerState>) {
    currentState = { ...currentState, ...partial };
    notify();
  }

  const controller = {
    subscribe: vi.fn((listener: (state: OAuthControllerState) => void) => {
      listeners.add(listener);
      listener({ ...currentState });
      return () => listeners.delete(listener);
    }),
    getState: vi.fn(() => ({ ...currentState })),
    checkStatus: vi.fn(async () => {}),
    initiateOAuth: vi.fn(async () => {}),
    completeOAuth: vi.fn(async (_code: string) => {}),
    cancelPending: vi.fn(() => {}),
  } as unknown as OAuthController;

  return { controller, setState };
}

// ---------------------------------------------------------------------------
// OAuthPanel tests
// ---------------------------------------------------------------------------

test("shows disconnected state with Connect button", async () => {
  const { controller } = makeOAuthControllerMock({ status: "disconnected" });

  const screen = render(<OAuthPanel controller={controller} />);

  // Panel is visible with "Connect Claude Code" label and Connect button
  await expect.element(screen.getByText(/Connect Claude Code/)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Connect/ }))
    .toBeVisible();
});

test("Initiate button calls controller.initiateOAuth()", async () => {
  const { controller } = makeOAuthControllerMock({ status: "disconnected" });

  const screen = render(<OAuthPanel controller={controller} />);

  await screen.getByRole("button", { name: /Connect/ }).click();

  expect(controller.initiateOAuth).toHaveBeenCalledTimes(1);
});

test("displays authorization URL from pending state", async () => {
  const authUrl = "https://claude.ai/oauth/authorize?state=test123";
  const { controller } = makeOAuthControllerMock({
    status: "pending",
    oauthUrl: authUrl,
    error: null,
  });

  const screen = render(<OAuthPanel controller={controller} />);

  await expect.element(screen.getByText(authUrl)).toBeVisible();
});

test("code input calls controller.completeOAuth with entered code", async () => {
  const authUrl = "https://claude.ai/oauth/authorize?state=test456";
  const { controller } = makeOAuthControllerMock({
    status: "pending",
    oauthUrl: authUrl,
  });

  const screen = render(<OAuthPanel controller={controller} />);

  await screen.getByPlaceholder("Confirmation code").fill("MY-CODE-123");
  await screen.getByRole("button", { name: /Submit/ }).click();

  expect(controller.completeOAuth).toHaveBeenCalledWith("MY-CODE-123");
});

test("shows connected state when status is connected", async () => {
  const { controller } = makeOAuthControllerMock({ status: "connected" });

  const screen = render(<OAuthPanel controller={controller} />);

  await expect.element(screen.getByText(/Claude Code Connected/)).toBeVisible();
});

test("shows error message from error state", async () => {
  const { controller } = makeOAuthControllerMock({
    status: "error",
    error: "Authentication failed — please try again",
  });

  const screen = render(<OAuthPanel controller={controller} />);

  await expect
    .element(screen.getByText("Authentication failed — please try again"))
    .toBeVisible();
});
