/**
 * Component tests for FeaturePane.
 *
 * Exercises the issue list, detail view, and steer form against a mocked
 * controller so the browser layer is covered without depending on a live
 * backend.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { FeaturePane } from "../../src/components/FeaturePane";
import type {
  FeaturePaneController,
  FeaturePaneState,
} from "../../src/controllers/FeaturePaneController";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFeaturePaneControllerMock(
  initialState: Partial<FeaturePaneState> = {},
): {
  controller: FeaturePaneController;
  setState: (partial: Partial<FeaturePaneState>) => void;
} {
  const defaultState: FeaturePaneState = {
    features: [
      {
        issueNumber: 42,
        title: "Refine the control chat",
        body: [
          "# Refine the control chat",
          "",
          "- [ ] render assistant output",
          "- [x] keep the submit button visible",
        ].join("\n"),
        sessionId: "sess-42",
      },
    ],
    selectedIssueNumber: null,
    loading: false,
    error: null,
    ...initialState,
  };

  let currentState = { ...defaultState };
  const listeners = new Set<(state: FeaturePaneState) => void>();

  function notify() {
    const snap = {
      ...currentState,
      features: [...currentState.features],
    };
    for (const l of listeners) l(snap);
  }

  function setState(partial: Partial<FeaturePaneState>) {
    currentState = { ...currentState, ...partial };
    notify();
  }

  const controller = {
    subscribe: vi.fn((listener: (state: FeaturePaneState) => void) => {
      listeners.add(listener);
      listener({
        ...currentState,
        features: [...currentState.features],
      });
      return () => listeners.delete(listener);
    }),
    getState: vi.fn(() => ({
      ...currentState,
      features: [...currentState.features],
    })),
    start: vi.fn(() => {}),
    stop: vi.fn(() => {}),
    selectFeature: vi.fn((issueNumber: number | null) => {
      setState({ selectedIssueNumber: issueNumber });
    }),
    steer: vi.fn(async (_text: string, _sessionId?: string) => {}),
  } as unknown as FeaturePaneController;

  return { controller, setState };
}

test("renders issue detail and forwards selected sessionId to steer", async () => {
  const { controller } = makeFeaturePaneControllerMock({
    selectedIssueNumber: 42,
  });

  const screen = render(<FeaturePane controller={controller} />);

  await expect.element(screen.getByTestId("feature-pane")).toBeVisible();
  await expect.element(screen.getByTestId("feature-detail")).toBeVisible();
  await expect.element(screen.getByText("#42")).toBeVisible();
  await expect
    .element(screen.getByText("Refine the control chat"))
    .toBeVisible();
  await expect
    .element(screen.getByText("render assistant output"))
    .toBeVisible();

  const textarea = screen.getByPlaceholder(
    /discuss changes to this feature spec/i,
  );
  await textarea.fill("Tighten the button copy");
  await screen.getByRole("button", { name: "SUBMIT" }).click();

  expect(controller.steer).toHaveBeenCalledWith(
    "Tighten the button copy",
    "sess-42",
  );
});

test("renders list view and selects an issue when a row is clicked", async () => {
  const { controller } = makeFeaturePaneControllerMock();
  const screen = render(<FeaturePane controller={controller} />);

  await expect.element(screen.getByTestId("feature-list")).toBeVisible();
  const row = screen.getByTestId("feature-row-42");
  await row.click();

  expect(controller.selectFeature).toHaveBeenCalledWith(42);
});
