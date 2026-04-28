/**
 * Component tests for RouteMap (D2).
 */

import React from "react";
import { render } from "vitest-browser-react";
import { describe, expect, test, vi } from "vitest";
import {
  RouteMap,
  type DemoRoute,
  loadSelectedRoute,
  saveSelectedRoute,
} from "../../src/components/RouteMap";

const FIXTURE: readonly DemoRoute[] = [
  { path: "/", title: "Landing", description: "" },
  { path: "/dashboard", title: "Customer dashboard", description: "" },
  { path: "/checkout", title: "Checkout", description: "" },
];

describe("RouteMap", () => {
  test("renders one button per route from the fixture", async () => {
    const onSelect = vi.fn();
    const screen = render(
      <RouteMap onSelect={onSelect} routesOverride={FIXTURE} />,
    );
    await expect.element(screen.getByTestId("route-map")).toBeVisible();
    await expect.element(screen.getByTestId("route-item-/")).toBeVisible();
    await expect
      .element(screen.getByTestId("route-item-/dashboard"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("route-item-/checkout"))
      .toBeVisible();
  });

  test("clicking a route calls onSelect with the path and persists it", async () => {
    const onSelect = vi.fn();
    const screen = render(
      <RouteMap onSelect={onSelect} routesOverride={FIXTURE} />,
    );
    await screen.getByTestId("route-item-/dashboard").click();
    expect(onSelect).toHaveBeenCalledWith("/dashboard");
    expect(loadSelectedRoute()).toBe("/dashboard");
  });

  test("renders nothing when fixture is empty", async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <RouteMap onSelect={onSelect} routesOverride={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("saveSelectedRoute / loadSelectedRoute round-trip", () => {
    saveSelectedRoute("/checkout");
    expect(loadSelectedRoute()).toBe("/checkout");
  });
});
