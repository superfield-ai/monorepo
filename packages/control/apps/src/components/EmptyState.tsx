/**
 * @file EmptyState.tsx
 *
 * One-line explanation panel for any list that may legitimately be empty
 * (slots, turns, commits, envs, conformance) (E12). Never a blank box.
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
      className="flex flex-col items-start gap-1 rounded border border-dashed border-zinc-700 bg-zinc-900/50 p-4 text-sm text-zinc-300"
    >
      <div className="font-medium text-zinc-200">{title}</div>
      {hint ? <div className="text-xs text-zinc-400">{hint}</div> : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          data-testid="empty-state-action"
          className="mt-2 rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white hover:bg-blue-600"
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
