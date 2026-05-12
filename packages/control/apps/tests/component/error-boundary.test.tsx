/**
 * Component tests for ErrorBoundary.
 *
 * Covers all 5 scenarios from issue #299:
 *  1. Children render normally when no error is thrown
 *  2. A render-time exception in a child is caught and the fallback UI renders
 *  3. Fallback UI contains a Retry / Reload affordance
 *  4. componentDidCatch records the error in debugStore (onError analogue)
 *  5. After clicking Retry, children render again without the fallback
 */

import React, { useState } from "react";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";
import { debugStore } from "../../src/lib/debug-store";

// Suppress React's own console.error noise during intentional throws.
let originalConsoleError: typeof console.error;

beforeEach(() => {
  debugStore.__resetForTest();
  originalConsoleError = console.error;
  console.error = vi.fn();
});

afterEach(() => {
  console.error = originalConsoleError;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A child that renders normally. */
function GoodChild() {
  return <span data-testid="good-child">OK</span>;
}

/** A child that throws unconditionally during render. */
function BadChild(): React.ReactNode {
  throw new Error("test render error");
}

/**
 * A wrapper that lets tests toggle between a good and bad child by flipping
 * a boolean state value, exercising the retry path.
 */
function ToggleWrapper({
  label,
  onReset,
}: {
  label: string;
  onReset?: () => void;
}) {
  const [shouldThrow, setShouldThrow] = useState(true);

  return (
    <ErrorBoundary
      label={label}
      onReset={() => {
        setShouldThrow(false);
        onReset?.();
      }}
    >
      {shouldThrow ? <BadChild /> : <GoodChild />}
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("scenario 1: children render normally when no error is thrown", async () => {
  const screen = render(
    <ErrorBoundary label="test-zone">
      <GoodChild />
    </ErrorBoundary>,
  );

  await expect.element(screen.getByTestId("good-child")).toBeVisible();
  expect(
    screen.container.querySelector('[data-testid="error-boundary-card"]'),
  ).toBeNull();
});

test("scenario 2: a render-time exception in a child triggers the fallback UI", async () => {
  const screen = render(
    <ErrorBoundary label="test-zone">
      <BadChild />
    </ErrorBoundary>,
  );

  await expect.element(screen.getByTestId("error-boundary-card")).toBeVisible();
  expect(
    screen.container.querySelector('[data-testid="good-child"]'),
  ).toBeNull();
});

test("scenario 3: fallback UI contains a Retry affordance", async () => {
  const screen = render(
    <ErrorBoundary label="test-zone">
      <BadChild />
    </ErrorBoundary>,
  );

  await expect
    .element(screen.getByTestId("error-boundary-retry"))
    .toBeVisible();
  // Also has a secondary "OPEN DEBUG VIEW" button.
  await expect
    .element(screen.getByTestId("error-boundary-debug"))
    .toBeVisible();
});

test("scenario 4: componentDidCatch records the error in debugStore", async () => {
  render(
    <ErrorBoundary label="my-label">
      <BadChild />
    </ErrorBoundary>,
  );

  // Wait a tick for React's error lifecycle to fire.
  await new Promise((r) => setTimeout(r, 20));

  const { entries } = debugStore.getState();
  expect(entries.length).toBeGreaterThan(0);
  const entry = entries[0];
  expect(entry.level).toBe("error");
  expect(entry.source).toBe("react");
  expect(entry.message).toContain("my-label");
  expect(entry.message).toContain("test render error");
});

test("scenario 5: clicking Retry clears the error and re-renders children", async () => {
  const onReset = vi.fn();
  const screen = render(<ToggleWrapper label="retry-test" onReset={onReset} />);

  // Fallback is visible first.
  await expect.element(screen.getByTestId("error-boundary-card")).toBeVisible();

  // Click Retry.
  await screen.getByTestId("error-boundary-retry").click();

  // Children should now render normally.
  await expect.element(screen.getByTestId("good-child")).toBeVisible();
  expect(
    screen.container.querySelector('[data-testid="error-boundary-card"]'),
  ).toBeNull();

  // onReset callback was invoked.
  expect(onReset).toHaveBeenCalledOnce();
});
