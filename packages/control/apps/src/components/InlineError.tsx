/**
 * @file InlineError.tsx
 *
 * In-panel error card with required Retry + optional "Copy details" / "Open
 * docs" affordances. Used everywhere a single sub-panel can fail without
 * tearing down the surrounding view (E9).
 */

import React from "react";
import type { AppError } from "../lib/errors";
import { formatAppError } from "../lib/errors";
import { toastStore } from "../lib/toast-store";

interface InlineErrorProps {
  readonly title: string;
  readonly error: AppError;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly docsHref?: string;
  readonly docsLabel?: string;
}

export function InlineError({
  title,
  error,
  onRetry,
  retryLabel = "Retry",
  docsHref,
  docsLabel = "Open docs",
}: InlineErrorProps): JSX.Element {
  const handleCopy = async (): Promise<void> => {
    const detail = formatAppError(error);
    await navigator.clipboard.writeText(detail);
    toastStore.show({
      severity: "success",
      title: "Copied error details",
      timeoutMs: 2000,
    });
  };

  return (
    <div
      role="alert"
      data-testid="inline-error"
      className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-100"
    >
      <div className="font-medium text-red-200">{title}</div>
      <div className="mt-1 break-words text-red-200/90">{error.message}</div>
      {error.hint ? (
        <div className="mt-1 text-xs text-red-200/70">Hint: {error.hint}</div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            data-testid="inline-error-retry"
            className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
          >
            {retryLabel}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleCopy}
          data-testid="inline-error-copy"
          className="rounded border border-red-500 px-2 py-1 text-xs font-medium text-red-100 hover:bg-red-900"
        >
          Copy details
        </button>
        {docsHref ? (
          <a
            href={docsHref}
            target="_blank"
            rel="noreferrer"
            data-testid="inline-error-docs"
            className="rounded border border-red-500 px-2 py-1 text-xs font-medium text-red-100 hover:bg-red-900"
          >
            {docsLabel}
          </a>
        ) : null}
      </div>
    </div>
  );
}
