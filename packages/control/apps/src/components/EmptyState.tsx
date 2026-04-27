/**
 * @file EmptyState.tsx
 *
 * One-line explanation panel for any list that may legitimately be empty
 * (slots, turns, commits, envs, conformance) (E12). Never a blank box.
 *
 * Visuals follow the Superfield Control Room design system: flat bg-raised
 * panel with a 1px subtle dashed border, mono ALL-CAPS title and INFO
 * status pill, cyan-outlined action button.
 */

import React from "react";

interface EmptyStateProps {
  readonly title: string;
  readonly hint?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** data-testid suffix; defaults to a slug of `title`. */
  readonly testId?: string;
}

export function EmptyState({
  title,
  hint,
  action,
  testId,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      role="status"
      data-testid={`empty-state-${testId ?? slug(title)}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "var(--sp-2)",
        background: "var(--bg-raised)",
        border: "1px dashed var(--border-default)",
        padding: "var(--sp-4)",
        color: "var(--fg-1)",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}
      >
        <span className="badge badge-info" data-pill="true">
          INFO
        </span>
        <span className="label" style={{ color: "var(--fg-1)" }}>
          {title}
        </span>
      </div>
      {hint ? (
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            color: "var(--fg-2)",
            lineHeight: "var(--lh-relaxed)",
          }}
        >
          {hint}
        </div>
      ) : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          data-testid="empty-state-action"
          style={{
            background: "transparent",
            border: "1px solid var(--accent-cyan)",
            color: "var(--accent-cyan)",
            padding: "var(--sp-1) var(--sp-3)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            letterSpacing: "var(--ls-wider)",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
