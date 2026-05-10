/**
 * Component tests for Studio browser interface — Layer 2.
 *
 * Covers:
 *  - IframePanel: iframe at src, reloading overlay on restarting, no overlay
 *    on healthy, overlay clears on restarting→healthy transition
 *  - ClusterStatusIndicator: green/healthy, amber-pulsing/restarting,
 *    red/degraded, gray/unknown
 *  - ControlPanel: three-tab structure (Studio/Viewport/Product), FeaturePane
 *    on Studio, IframePanel on Viewport, ProductTab on Product
 *
 * All tests inject mock controllers as props — no real fetch calls are made.
 *
 * Canonical docs: test-plan.md §Layer 2.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IframePanel } from "../../src/components/IframePanel";
import { ClusterStatusIndicator } from "../../src/components/ClusterStatusIndicator";
import { ControlPanel } from "../../src/components/ControlPanel";
import { debugStore } from "../../src/lib/debug-store";

beforeEach(() => {
  debugStore.__resetForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// IframePanel tests
// ---------------------------------------------------------------------------

test("iframe panel renders iframe at given src", async () => {
  const screen = render(<IframePanel src="/app/" clusterStatus="healthy" />);
  await expect.element(screen.getByTestId("iframe-panel")).toBeVisible();
  await expect.element(screen.getByTestId("app-iframe")).toBeVisible();
});

test("reloading overlay appears when clusterStatus is restarting", async () => {
  const screen = render(<IframePanel src="/app/" clusterStatus="restarting" />);
  await expect.element(screen.getByTestId("reloading-overlay")).toBeVisible();
  await expect
    .element(screen.getByText(/Reloading — cluster is restarting/))
    .toBeVisible();
});

test("no reloading overlay when clusterStatus is healthy", async () => {
  const screen = render(<IframePanel src="/app/" clusterStatus="healthy" />);
  await expect.element(screen.getByTestId("iframe-panel")).toBeVisible();
  const overlay = screen.container.querySelector(
    '[data-testid="reloading-overlay"]',
  );
  expect(overlay).toBeNull();
});

test("overlay disappears when clusterStatus transitions from restarting to healthy", async () => {
  const { rerender, container } = render(
    <IframePanel src="/app/" clusterStatus="restarting" />,
  );
  expect(
    container.querySelector('[data-testid="reloading-overlay"]'),
  ).not.toBeNull();

  rerender(<IframePanel src="/app/" clusterStatus="healthy" />);
  expect(
    container.querySelector('[data-testid="reloading-overlay"]'),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// ClusterStatusIndicator tests
// ---------------------------------------------------------------------------

test("cluster status indicator shows green for healthy", async () => {
  const screen = render(<ClusterStatusIndicator statusOverride="healthy" />);
  await expect
    .element(screen.getByTestId("cluster-status-indicator"))
    .toBeVisible();
  await expect.element(screen.getByText("CLUSTER NOMINAL")).toBeVisible();
});

test("cluster status indicator shows amber pulsing for restarting", async () => {
  const screen = render(<ClusterStatusIndicator statusOverride="restarting" />);
  await expect
    .element(screen.getByTestId("cluster-status-indicator"))
    .toBeVisible();
  await expect.element(screen.getByText("CLUSTER RESTARTING")).toBeVisible();
});

test("cluster status indicator shows red for degraded", async () => {
  const screen = render(<ClusterStatusIndicator statusOverride="degraded" />);
  await expect
    .element(screen.getByTestId("cluster-status-indicator"))
    .toBeVisible();
  await expect.element(screen.getByText("CLUSTER DEGRADED")).toBeVisible();
});

test("cluster status indicator shows gray for unknown", async () => {
  const screen = render(<ClusterStatusIndicator statusOverride="unknown" />);
  await expect
    .element(screen.getByTestId("cluster-status-indicator"))
    .toBeVisible();
  await expect.element(screen.getByText("CLUSTER UNKNOWN")).toBeVisible();
});

// ---------------------------------------------------------------------------
// ControlPanel tests
// ---------------------------------------------------------------------------

test("studio panel renders FeaturePane on the Studio tab at 1280x800", async () => {
  const screen = render(
    <div style={{ width: "1280px", height: "800px" }}>
      <ControlPanel
        appSrc="/app/"
        initialClusterStatus="healthy"
        hideConnectionBanner
      />
    </div>,
  );
  await expect.element(screen.getByTestId("studio-panel")).toBeVisible();
  await expect.element(screen.getByTestId("feature-pane")).toBeVisible();
  expect(
    screen.container.querySelector('[data-testid="iframe-panel"]'),
  ).toBeNull();
});

test("studio panel has three tabs: Studio, Viewport, Product", async () => {
  const screen = render(
    <ControlPanel
      appSrc="/app/"
      initialClusterStatus="healthy"
      hideConnectionBanner
    />,
  );
  await expect.element(screen.getByTestId("tab-studio")).toBeVisible();
  await expect.element(screen.getByTestId("tab-viewport")).toBeVisible();
  await expect.element(screen.getByTestId("tab-product")).toBeVisible();
});

test("switching to Viewport tab shows IframePanel and hides FeaturePane", async () => {
  const screen = render(
    <ControlPanel
      appSrc="/app/"
      initialClusterStatus="restarting"
      hideConnectionBanner
    />,
  );
  await screen.getByTestId("tab-viewport").click();
  await expect.element(screen.getByTestId("reloading-overlay")).toBeVisible();
  expect(
    screen.container.querySelector('[data-testid="feature-pane"]'),
  ).toBeNull();
});

test("switching to Product tab shows product-tab panel", async () => {
  const screen = render(
    <ControlPanel
      appSrc="/app/"
      initialClusterStatus="healthy"
      hideConnectionBanner
    />,
  );
  await screen.getByTestId("tab-product").click();
  await expect.element(screen.getByTestId("product-tab")).toBeVisible();
});

test("clicking the debug badge opens the DebugView and marks unread events read", async () => {
  debugStore.record({
    level: "warn",
    source: "console",
    message: "debug badge test",
  });

  const screen = render(
    <ControlPanel
      appSrc="/app/"
      initialClusterStatus="healthy"
      hideConnectionBanner
    />,
  );

  await expect
    .element(screen.getByTestId("debug-badge-count"))
    .toHaveTextContent("FAULT 1");

  await screen.getByTestId("debug-badge").click();
  await expect.element(screen.getByTestId("debug-view")).toBeVisible();
  await expect
    .element(screen.getByTestId("debug-badge-count"))
    .toHaveTextContent("FAULT 0");
});

test("studio panel propagates status update to IframePanel on Viewport tab", async () => {
  const { rerender, container } = render(
    <ControlPanel
      appSrc="/app/"
      initialClusterStatus="healthy"
      hideConnectionBanner
    />,
  );

  const viewportTab = container.querySelector(
    '[data-testid="tab-viewport"]',
  ) as HTMLElement;
  viewportTab?.click();

  rerender(
    <ControlPanel
      appSrc="/app/"
      initialClusterStatus="restarting"
      hideConnectionBanner
    />,
  );

  expect(
    container.querySelector('[data-testid="reloading-overlay"]'),
  ).not.toBeNull();
});
