/**
 * Component tests for MockRouteGallery (issue #322).
 *
 * Injects a stub MockRouteController so no real fetch calls are made.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { describe, expect, test, vi } from "vitest";
import { MockRouteGallery } from "../../src/components/MockRouteGallery";
import {
  MockRouteController,
  type MockRoute,
  type MockRouteState,
  type MockRouteListener,
} from "../../src/controllers/MockRouteController";

// ── Stub controller ──────────────────────────────────────────────────────────

function makeController(overrides: Partial<MockRouteState> = {}): MockRouteController {
  const state: MockRouteState = {
    routes: [],
    loading: false,
    toggling: new Set(),
    error: null,
    ...overrides,
  };
  const listeners = new Set<MockRouteListener>();
  const ctrl = {
    getState: () => ({ ...state, routes: [...state.routes], toggling: new Set(state.toggling) }),
    subscribe: (l: MockRouteListener) => {
      listeners.add(l);
      l(ctrl.getState());
      return () => listeners.delete(l);
    },
    loadRoutes: vi.fn().mockResolvedValue(undefined),
    toggleRoute: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockRouteController;
  return ctrl;
}

const ROUTES: readonly MockRoute[] = [
  { id: "r1", method: "GET", path: "/api/users", enabled: true },
  { id: "r2", method: "POST", path: "/api/posts", enabled: false },
  { id: "r3", method: "DELETE", path: "/api/items/1", enabled: true },
];

describe("MockRouteGallery", () => {
  test("renders the gallery container", async () => {
    const screen = render(
      <MockRouteGallery controller={makeController()} />,
    );
    await expect
      .element(screen.getByTestId("mock-route-gallery"))
      .toBeVisible();
  });

  test("renders one row per route entry", async () => {
    const screen = render(
      <MockRouteGallery controller={makeController({ routes: ROUTES })} />,
    );
    await expect
      .element(screen.getByTestId("mock-route-table"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("mock-route-row-r1"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("mock-route-row-r2"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("mock-route-row-r3"))
      .toBeVisible();
  });

  test("each row shows method and path", async () => {
    const screen = render(
      <MockRouteGallery controller={makeController({ routes: ROUTES })} />,
    );
    const row = screen.getByTestId("mock-route-row-r1");
    await expect.element(row).toHaveTextContent("GET");
    await expect.element(row).toHaveTextContent("/api/users");
  });

  test("shows empty-state when routes list is empty", async () => {
    const screen = render(
      <MockRouteGallery controller={makeController({ routes: [], loading: false })} />,
    );
    await expect
      .element(screen.getByTestId("mock-route-empty"))
      .toBeVisible();
  });

  test("shows error state when controller reports an error", async () => {
    const screen = render(
      <MockRouteGallery
        controller={makeController({ error: "Network unreachable", routes: [] })}
      />,
    );
    await expect
      .element(screen.getByTestId("mock-route-error"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("mock-route-error"))
      .toHaveTextContent("Network unreachable");
  });

  test("refresh button is present and enabled when not loading", async () => {
    const ctrl = makeController({ routes: ROUTES });
    const screen = render(<MockRouteGallery controller={ctrl} />);
    const btn = screen.getByTestId("mock-route-refresh");
    await expect.element(btn).toBeVisible();
    await expect.element(btn).not.toBeDisabled();
  });

  test("toggle button is rendered for each route", async () => {
    const screen = render(
      <MockRouteGallery controller={makeController({ routes: ROUTES })} />,
    );
    await expect
      .element(screen.getByTestId("toggle-r1"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("toggle-r2"))
      .toBeVisible();
  });
});
