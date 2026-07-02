/**
 * Unit tests for FeaturePaneController.
 *
 * Covers the browser-side steer and update paths used by the Studio tab:
 *  - sends both context and sessionId to /studio/steer
 *  - surfaces a visible error when no session is selected
 *  - captures backend rejection so the UI can render it
 *  - patchFeature POSTs the reconciled `/studio/issues/update { id, title }`
 *    route (issue #835), keyed on the project-graph node id
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

  it("POSTs the reconciled update to /studio/issues/update with the node id", async () => {
    // issue #835: the control frontend and sf-serve must agree on exactly one
    // feature-update route+method+payload. sf-serve registers only
    // `POST /studio/issues/update { id, state?, title? }` (there is no
    // `PATCH /studio/issues/:n`), so patchFeature must POST there with the
    // project-graph node id resolved from the loaded feature list.
    const nodeId = "11111111-1111-1111-1111-111111111111";
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/analytics/slots") return makeJsonResponse({ slots: [] });
      if (url === "/studio/issues")
        return makeJsonResponse({
          issues: [
            {
              number: 42,
              id: nodeId,
              title: "orig",
              body: "orig",
              status: "open",
            },
          ],
        });
      if (url === "/studio/issues/update")
        return makeJsonResponse({ updated: true, id: nodeId });
      return makeJsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new FeaturePaneController();
    // Populate the feature list (and thus the node id) via the load path.
    ctrl.start();
    ctrl.stop();
    await vi.waitFor(() =>
      expect(ctrl.getState().features.length).toBeGreaterThan(0),
    );

    await ctrl.patchFeature(42, "reconciled body");

    const updateCall = fetchMock.mock.calls.find(
      ([u]) => u === "/studio/issues/update",
    );
    expect(
      updateCall,
      "patchFeature must POST /studio/issues/update",
    ).toBeDefined();
    const init = updateCall![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      id: nodeId,
      title: "reconciled body",
    });
    expect(ctrl.getState().error).toBeNull();
  });

  it("errors when the selected feature has no backing DB node", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeJsonResponse({})),
    );
    const ctrl = new FeaturePaneController();
    // No features loaded → no node id to update.
    await ctrl.patchFeature(999, "no record");
    expect(ctrl.getState().error).toBe("NO DB RECORD TO UPDATE");
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
