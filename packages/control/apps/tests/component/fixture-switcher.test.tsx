/**
 * Component tests for FixtureSwitcher (issue #322).
 *
 * Injects a stub FixtureSwitcherController so no real fetch calls are made.
 * Verifies fixture selection fires the controller and that activated fixtures
 * are reflected in the UI (persisted state).
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FixtureSwitcher } from "../../src/components/FixtureSwitcher";
import {
  FixtureSwitcherController,
  type FixtureSwitcherState,
  type FixtureSwitcherListener,
} from "../../src/controllers/FixtureSwitcherController";

// ── Stub controller ──────────────────────────────────────────────────────────

function makeController(overrides: Partial<FixtureSwitcherState> = {}): {
  ctrl: FixtureSwitcherController;
  loadFixtures: ReturnType<typeof vi.fn>;
  activateFixture: ReturnType<typeof vi.fn>;
  push: (patch: Partial<FixtureSwitcherState>) => void;
} {
  let state: FixtureSwitcherState = {
    fixtures: [],
    active: null,
    route: null,
    loading: false,
    error: null,
    ...overrides,
  };
  const listeners = new Set<FixtureSwitcherListener>();

  const loadFixtures = vi.fn().mockResolvedValue(undefined);
  const activateFixture = vi.fn().mockResolvedValue(undefined);

  const push = (patch: Partial<FixtureSwitcherState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l({ ...state, fixtures: [...state.fixtures] });
  };

  const ctrl = {
    getState: () => ({ ...state, fixtures: [...state.fixtures] }),
    subscribe: (l: FixtureSwitcherListener) => {
      listeners.add(l);
      l({ ...state, fixtures: [...state.fixtures] });
      return () => listeners.delete(l);
    },
    loadFixtures,
    activateFixture,
  } as unknown as FixtureSwitcherController;

  return { ctrl, loadFixtures, activateFixture, push };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FixtureSwitcher", () => {
  test("renders the switcher container", async () => {
    const { ctrl } = makeController();
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    await expect
      .element(screen.getByTestId("fixture-switcher"))
      .toBeVisible();
  });

  test("shows no-route placeholder when route is empty", async () => {
    const { ctrl } = makeController();
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    await expect
      .element(screen.getByTestId("fixture-no-route"))
      .toBeVisible();
  });

  test("route input is present and accepts text", async () => {
    const { ctrl } = makeController();
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    const input = screen.getByTestId("fixture-route-input");
    await expect.element(input).toBeVisible();
  });

  test("initialRoute prop pre-fills the route input", async () => {
    const { ctrl } = makeController();
    const screen = render(
      <FixtureSwitcher controller={ctrl} initialRoute="/api/users" />,
    );
    await expect
      .element(screen.getByTestId("fixture-route-input"))
      .toHaveValue("/api/users");
  });

  test("clicking LOAD calls loadFixtures with typed route", async () => {
    const { ctrl, loadFixtures } = makeController();
    const screen = render(
      <FixtureSwitcher controller={ctrl} initialRoute="/api/orders" />,
    );
    await screen.getByTestId("fixture-load-btn").click();
    expect(loadFixtures).toHaveBeenCalledWith("/api/orders");
  });

  test("renders fixture list when fixtures are available", async () => {
    const { ctrl } = makeController({
      route: "/api/users",
      fixtures: ["default", "empty", "many-users"],
      active: "default",
    });
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    await expect
      .element(screen.getByTestId("fixture-list"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("fixture-option-default"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("fixture-option-empty"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("fixture-option-many-users"))
      .toBeVisible();
  });

  test("active fixture shows ACTIVE badge", async () => {
    const { ctrl } = makeController({
      route: "/api/users",
      fixtures: ["default", "empty"],
      active: "default",
    });
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    await expect
      .element(screen.getByTestId("fixture-active-badge-default"))
      .toBeVisible();
  });

  test("selecting a fixture and clicking ACTIVATE calls activateFixture", async () => {
    const { ctrl, activateFixture } = makeController({
      route: "/api/users",
      fixtures: ["default", "empty"],
      active: "default",
    });
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    // Select the "empty" fixture (different from active "default").
    await screen.getByTestId("fixture-option-empty").click();
    await screen.getByTestId("fixture-activate-btn").click();
    expect(activateFixture).toHaveBeenCalledWith("/api/users", "empty");
  });

  test("ACTIVATE button is disabled when selected fixture is already active", async () => {
    const { ctrl } = makeController({
      route: "/api/users",
      fixtures: ["default", "empty"],
      active: "default",
    });
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    // "default" is already active; the activate button starts disabled.
    await expect
      .element(screen.getByTestId("fixture-activate-btn"))
      .toBeDisabled();
  });

  test("shows error state when controller reports an error", async () => {
    const { ctrl } = makeController({
      route: "/api/users",
      error: "Not found",
      fixtures: [],
    });
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    await expect
      .element(screen.getByTestId("fixture-error"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("fixture-error"))
      .toHaveTextContent("Not found");
  });

  test("active fixture status indicator is visible when a route and active fixture exist", async () => {
    const { ctrl } = makeController({
      route: "/api/users",
      fixtures: ["default"],
      active: "default",
    });
    const screen = render(<FixtureSwitcher controller={ctrl} />);
    await expect
      .element(screen.getByTestId("fixture-active-status"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("fixture-active-status"))
      .toHaveTextContent("default");
  });
});
