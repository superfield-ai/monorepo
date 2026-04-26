/**
 * Unit tests for OAuthController — Layer 1b (headless Chromium).
 *
 * All fetch calls are intercepted via vi.stubGlobal('fetch', ...).
 * localStorage is a real browser global in the Chromium context.
 *
 * Canonical docs: test-plan.md §Layer 1b / OAuthController test matrix.
 *
 * Scenarios covered (4):
 *  1. Initial state is disconnected
 *  2. initiateOAuth() GETs /api/auth/oauth/init and sets pending with URL
 *  3. completeOAuth(code) POSTs and transitions to connected
 *  4. Error response from completeOAuth sets error with message
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthController } from "../../src/controllers/OAuthController";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OAuthController", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("starts in disconnected state", () => {
    // Scenario 1: Initial state is disconnected
    const ctrl = new OAuthController();
    const state = ctrl.getState();
    expect(state.status).toBe("disconnected");
    expect(state.oauthUrl).toBeNull();
    expect(state.error).toBeNull();
  });

  it("transitions to pending with oauthUrl after initiateOAuth()", async () => {
    // Scenario 2: initiateOAuth() GETs /api/auth/oauth/init and sets pending
    const authUrl = "https://claude.ai/oauth/authorize?state=abc";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeJsonResponse({ url: authUrl }))),
    );

    const ctrl = new OAuthController({ baseUrl: "" });
    await ctrl.initiateOAuth();

    const state = ctrl.getState();
    expect(state.status).toBe("pending");
    expect(state.oauthUrl).toBe(authUrl);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/auth/oauth/init",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("transitions to connected after completeOAuth() posts successfully", async () => {
    // Scenario 3: completeOAuth(code) POSTs and transitions to connected
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeJsonResponse({ ok: true }))),
    );

    const ctrl = new OAuthController({ baseUrl: "" });
    await ctrl.completeOAuth("my-confirmation-code");

    const state = ctrl.getState();
    expect(state.status).toBe("connected");
    expect(state.error).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/auth/oauth/complete",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sets error state when completeOAuth() receives a non-ok response", async () => {
    // Scenario 4: error response from completeOAuth sets error with message
    const errorMsg = "Invalid confirmation code";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeJsonResponse({ error: errorMsg }, 400))),
    );

    const ctrl = new OAuthController({ baseUrl: "" });
    await ctrl.completeOAuth("bad-code");

    const state = ctrl.getState();
    expect(state.status).toBe("error");
    expect(state.error).toBe(errorMsg);
  });
});
