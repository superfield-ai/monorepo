/**
 * Component tests for ChatComposer — presentational composer component.
 *
 * Covers:
 *  - Enter key fires onSubmit callback
 *  - Shift+Enter does NOT fire onSubmit (allows newline)
 *  - Submit button disabled when value is empty
 *  - Submit button disabled when disabled prop is true
 *  - Typing in textarea calls onChange with new value
 *
 * All tests use mock callbacks passed as props.
 * Keyboard interactions use the userEvent API from @vitest/browser/context
 * so events go through the browser's full event dispatch pipeline.
 */

import React, { useState } from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "@vitest/browser/context";
import { ChatComposer } from "../../src/components/chat/ChatComposer";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// Test: Enter key fires onSubmit
// ─────────────────────────────────────────────────────────────────────────

test("Enter key fires onSubmit callback", async () => {
  const onSubmit = vi.fn();
  const onChange = vi.fn();

  const screen = render(
    <ChatComposer
      value="Hello world"
      onChange={onChange}
      onSubmit={onSubmit}
    />,
  );

  const textarea = screen.getByTestId("chat-composer-input");
  await textarea.click();
  await userEvent.keyboard("{Enter}");

  expect(onSubmit).toHaveBeenCalledTimes(1);
});

// ─────────────────────────────────────────────────────────────────────────
// Test: Shift+Enter does NOT fire onSubmit
// ─────────────────────────────────────────────────────────────────────────

test("Shift+Enter does NOT fire onSubmit (allows newline)", async () => {
  const onSubmit = vi.fn();
  const onChange = vi.fn();

  const screen = render(
    <ChatComposer
      value="Hello world"
      onChange={onChange}
      onSubmit={onSubmit}
    />,
  );

  const textarea = screen.getByTestId("chat-composer-input");
  await textarea.click();
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

  expect(onSubmit).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────
// Test: Submit button disabled when value is empty
// ─────────────────────────────────────────────────────────────────────────

test("Submit button is disabled when value is empty", async () => {
  const onSubmit = vi.fn();
  const onChange = vi.fn();

  const screen = render(
    <ChatComposer value="" onChange={onChange} onSubmit={onSubmit} />,
  );

  const button = screen.getByTestId("chat-composer-submit");
  await expect.element(button).toBeDisabled();
});

// ─────────────────────────────────────────────────────────────────────────
// Test: Submit button disabled when disabled prop is true
// ─────────────────────────────────────────────────────────────────────────

test("Submit button is disabled when disabled prop is true", async () => {
  const onSubmit = vi.fn();
  const onChange = vi.fn();

  const screen = render(
    <ChatComposer
      value="Hello world"
      onChange={onChange}
      onSubmit={onSubmit}
      disabled={true}
    />,
  );

  const button = screen.getByTestId("chat-composer-submit");
  await expect.element(button).toBeDisabled();
});

// ─────────────────────────────────────────────────────────────────────────
// Test: Typing in textarea calls onChange
// ─────────────────────────────────────────────────────────────────────────

test("Typing in textarea calls onChange with new value", async () => {
  const onSubmit = vi.fn();
  const onChange = vi.fn();

  const TestWrapper = () => {
    const [value, setValue] = useState("");
    return (
      <ChatComposer
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        onSubmit={onSubmit}
      />
    );
  };

  const screen = render(<TestWrapper />);

  const textarea = screen.getByTestId("chat-composer-input");
  await userEvent.type(textarea, "test");

  expect(onChange).toHaveBeenCalled();
});
