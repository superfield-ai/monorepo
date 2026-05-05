/**
 * @file ChatComposer
 *
 * Standalone composer component (textarea + submit button).
 * Extracted from the shared code in ChatPanel and ProductTab.
 *
 * Behavior:
 *  - Enter fires onSubmit, does not add newline
 *  - Shift+Enter adds newline without submitting
 *  - Auto-resize textarea based on content (single row baseline)
 *  - Submit button disabled when disabled prop is true or value is empty
 */

import React, { useRef, useEffect } from "react";
import { Send } from "lucide-react";

export interface ChatComposerProps {
  /** Current textarea value */
  value: string;
  /** Called when user types */
  onChange: (value: string) => void;
  /** Called when user presses Enter (not Shift+Enter) */
  onSubmit: () => void;
  /** Disables textarea and submit button */
  disabled?: boolean;
  /** Textarea placeholder text */
  placeholder?: string;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "ENTER PROMPT…",
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!disabled && value.trim()) {
      onSubmit();
    }
  }

  const isDisabled = disabled || !value.trim();

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="chat-composer-form"
      style={{
        padding: "var(--sp-3) var(--sp-4)",
        borderTop: "1px solid var(--border-subtle)",
        background: "var(--bg-raised)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: "var(--sp-2)",
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          aria-label="Chat composer input"
          data-testid="chat-composer-input"
          style={{
            flex: 1,
            resize: "none",
            background: "var(--bg-base)",
            border: "1px solid var(--border-subtle)",
            color: "var(--fg-1)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            padding: "var(--sp-2) var(--sp-3)",
            outline: "none",
            opacity: disabled ? 0.5 : 1,
          }}
        />
        <button
          type="submit"
          disabled={isDisabled}
          aria-label="Send message"
          data-testid="chat-composer-submit"
          style={{
            padding: "var(--sp-2) var(--sp-3)",
            background: "transparent",
            border: "1px solid var(--accent-cyan)",
            color: "var(--accent-cyan)",
            cursor: isDisabled ? "not-allowed" : "pointer",
            opacity: isDisabled ? 0.4 : 1,
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <Send size={16} />
        </button>
      </div>
    </form>
  );
}
