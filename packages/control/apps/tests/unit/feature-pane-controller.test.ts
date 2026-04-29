/**
 * Unit tests for FeaturePaneController.
 *
 * Covers the browser-side steer path used by the Studio tab:
 *  - sends both context and sessionId to /studio/steer
 *  - surfaces a visible error when no session is selected
 *  - captures backend rejection so the UI can render it
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { FeaturePaneController } from "../../src/controllers/FeaturePaneController";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeaturePaneController", () => {
  it("POSTs context and sessionId to /studio/steer", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeJsonResponse({ accepted: true, requestId: "req-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new FeaturePaneController();
    await ctrl.steer("tighten the button spacing", "sess-123");

    expect(fetchMock).toHaveBeenCalledWith(
      "/studio/steer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          context: "tighten the button spacing",
          sessionId: "sess-123",
        }),
      }),
    );
    expect(ctrl.getState().error).toBeNull();
  });

  it("sets an error when no session is selected", async () => {
    const ctrl = new FeaturePaneController();
    await ctrl.steer("tighten the button spacing");
    expect(ctrl.getState().error).toBe(
      "SELECT A RUNNING ISSUE BEFORE STEERING",
    );
  });

  it("surfaces backend rejections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeJsonResponse({ error: "sessionId is required" }, 400),
      ),
    );

    const ctrl = new FeaturePaneController();
    await ctrl.steer("tighten the button spacing", "sess-123");
    expect(ctrl.getState().error).toBe("sessionId is required");
  });
});
