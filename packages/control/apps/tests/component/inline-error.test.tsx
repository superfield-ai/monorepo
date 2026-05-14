/**
 * Component tests for InlineError.
 *
 * Verifies message rendering, retry button presence/absence, retry callback
 * wiring, detail copying, and hint display.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { InlineError } from "../../src/components/InlineError";
import type { AppError } from "../../src/lib/errors";
import { toastStore } from "../../src/lib/toast-store";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const baseError: AppError = {
  code: "server",
  message: "Something went wrong",
};

const errorWithHint: AppError = {
  code: "network",
  message: "Connection refused",
  hint: "Check your network settings",
};

beforeEach(() => {
  toastStore.__resetForTest();
  // Stub clipboard so "Copy details" doesn't throw in test environment
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  toastStore.__resetForTest();
});

describe("InlineError", () => {
  it("renders the error message text when message prop is provided", () => {
    const screen = render(
      <InlineError title="Load failed" error={baseError} />,
    );
    const container = screen.container;
    expect(
      container.querySelector('[data-testid="inline-error"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Something went wrong");
  });

  it("renders a Retry button when onRetry prop is provided", () => {
    const onRetry = vi.fn();
    const screen = render(
      <InlineError title="Load failed" error={baseError} onRetry={onRetry} />,
    );
    const btn = screen.container.querySelector(
      '[data-testid="inline-error-retry"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain("RETRY");
  });

  it("clicking Retry calls onRetry exactly once", async () => {
    const onRetry = vi.fn();
    const screen = render(
      <InlineError title="Load failed" error={baseError} onRetry={onRetry} />,
    );
    const btn = screen.container.querySelector(
      '[data-testid="inline-error-retry"]',
    ) as HTMLButtonElement;
    btn.click();
    await flush();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not render a Retry button when onRetry is absent", () => {
    const screen = render(
      <InlineError title="Load failed" error={baseError} />,
    );
    expect(
      screen.container.querySelector('[data-testid="inline-error-retry"]'),
    ).toBeNull();
  });

  it("renders a Copy details button that writes formatted error to clipboard", async () => {
    const screen = render(
      <InlineError title="Load failed" error={baseError} />,
    );
    const btn = screen.container.querySelector(
      '[data-testid="inline-error-copy"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("[server] Something went wrong"),
    );
  });

  it("renders hint text when error.hint is provided", () => {
    const screen = render(
      <InlineError title="Network error" error={errorWithHint} />,
    );
    expect(screen.container.textContent).toContain(
      "Check your network settings",
    );
  });

  it("does not render hint section when error.hint is absent", () => {
    const screen = render(
      <InlineError title="Load failed" error={baseError} />,
    );
    expect(screen.container.textContent).not.toContain("HINT:");
  });

  it("renders a docs link when docsHref is provided", () => {
    const screen = render(
      <InlineError
        title="Load failed"
        error={baseError}
        docsHref="https://docs.example.com"
        docsLabel="View docs"
      />,
    );
    const link = screen.container.querySelector(
      '[data-testid="inline-error-docs"]',
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.href).toContain("docs.example.com");
  });

  it("does not render a docs link when docsHref is absent", () => {
    const screen = render(
      <InlineError title="Load failed" error={baseError} />,
    );
    expect(
      screen.container.querySelector('[data-testid="inline-error-docs"]'),
    ).toBeNull();
  });

  it("renders a custom retryLabel when provided", () => {
    const onRetry = vi.fn();
    const screen = render(
      <InlineError
        title="Load failed"
        error={baseError}
        onRetry={onRetry}
        retryLabel="Try again"
      />,
    );
    const btn = screen.container.querySelector(
      '[data-testid="inline-error-retry"]',
    ) as HTMLButtonElement;
    expect(btn?.textContent).toContain("TRY AGAIN");
  });

  it("has role=alert for accessibility", () => {
    const screen = render(
      <InlineError title="Load failed" error={baseError} />,
    );
    const el = screen.container.querySelector('[role="alert"]');
    expect(el).not.toBeNull();
  });
});
