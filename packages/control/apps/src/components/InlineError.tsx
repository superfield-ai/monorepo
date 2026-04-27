/**
 * @file InlineError.tsx
 *
 * In-panel error card with required Retry + optional "Copy details" / "Open
 * docs" affordances. Used everywhere a single sub-panel can fail without
 * tearing down the surrounding view (E9).
 *
 * Visuals follow the Superfield Control Room design system: flat bg-raised
 * panel on a status-critical 1px border, FAULT badge, mono ALL-CAPS labels,
 * status-coloured outlined action buttons.
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

const actionButton: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--accent-red)",
  color: "var(--accent-red)",
  padding: "var(--sp-1) var(--sp-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
};

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
      title: "COPIED — ERROR DETAILS",
      timeoutMs: 2000,
    });
  };

  return (
    <div
      role="alert"
      data-testid="inline-error"
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--accent-red)",
        padding: "var(--sp-3)",
        color: "var(--fg-1)",
        boxShadow: "var(--glow-red)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          marginBottom: "var(--sp-1)",
        }}
      >
        <span className="badge badge-critical" data-pill="true">
          FAULT
        </span>
        <span className="label" style={{ color: "var(--fg-1)" }}>
          {title}
        </span>
      </div>
      <div
        style={{
          marginTop: "var(--sp-1)",
          wordBreak: "break-word",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
          lineHeight: "var(--lh-relaxed)",
        }}
      >
        {error.message}
      </div>
      {error.hint ? (
        <div
          style={{
            marginTop: "var(--sp-1)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            letterSpacing: "var(--ls-wider)",
            textTransform: "uppercase",
          }}
        >
          HINT: {error.hint}
        </div>
      ) : null}
      <div
        style={{
          marginTop: "var(--sp-2)",
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sp-2)",
        }}
      >
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            data-testid="inline-error-retry"
            style={{
              ...actionButton,
              background: "var(--accent-red)",
              color: "var(--fg-inv)",
            }}
          >
            {retryLabel.toUpperCase()}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleCopy}
          data-testid="inline-error-copy"
          style={actionButton}
        >
          COPY DETAILS
        </button>
        {docsHref ? (
          <a
            href={docsHref}
            target="_blank"
            rel="noreferrer"
            data-testid="inline-error-docs"
            style={actionButton}
          >
            {docsLabel.toUpperCase()}
          </a>
        ) : null}
      </div>
    </div>
  );
}
