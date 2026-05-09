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
 */

import React, { useState } from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
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

  const { getByTestId } = render(
    <ChatComposer
      value="Hello world"
      onChange={onChange}
      onSubmit={onSubmit}
    />,
  );

  const textarea = getByTestId("chat-composer-input") as HTMLTextAreaElement;
  textarea.focus();

  // Simulate Enter key press
  const enterEvent = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(enterEvent);

  expect(onSubmit).toHaveBeenCalledTimes(1);
});

// ─────────────────────────────────────────────────────────────────────────
// Test: Shift+Enter does NOT fire onSubmit
// ─────────────────────────────────────────────────────────────────────────

test("Shift+Enter does NOT fire onSubmit (allows newline)", async () => {
  const onSubmit = vi.fn();
  const onChange = vi.fn();

  const { getByTestId } = render(
    <ChatComposer
      value="Hello world"
      onChange={onChange}
      onSubmit={onSubmit}
    />,
  );

  const textarea = getByTestId("chat-composer-input") as HTMLTextAreaElement;
  textarea.focus();

  // Simulate Shift+Enter key press
  const shiftEnterEvent = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(shiftEnterEvent);

  expect(onSubmit).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────
// Test: Submit button disabled when value is empty
// ─────────────────────────────────────────────────────────────────────────

test("Submit button is disabled when value is empty", async () => {
  const onSubmit = vi.fn();
  const onChange = vi.fn();

  const { getByTestId } = render(
    <ChatComposer value="" onChange={onChange} onSubmit={onSubmit} />,
  );

  const button = getByTestId("chat-composer-submit") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// Test: Submit button disabled when disabled prop is true
// ─────────────────────────────────────────────────────────────────────────

test("Submit button is disabled when disabled prop is true", async () => {
  const onSubmit = vi.fn();
  const onChange = vi.fn();

  const { getByTestId } = render(
    <ChatComposer
      value="Hello world"
      onChange={onChange}
      onSubmit={onSubmit}
      disabled={true}
    />,
  );

  const button = getByTestId("chat-composer-submit") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
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

  const { getByTestId } = render(<TestWrapper />);

  const textarea = getByTestId("chat-composer-input") as HTMLTextAreaElement;
  textarea.value = "test";
  textarea.dispatchEvent(new Event("change", { bubbles: true }));

  expect(onChange).toHaveBeenCalled();
});
