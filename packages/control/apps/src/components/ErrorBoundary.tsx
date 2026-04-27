/**
 * @file ErrorBoundary.tsx
 *
 * Top-level React error boundary. Wraps every route so a render-time exception
 * surfaces a labelled error card with a Retry button and a link to the
 * DebugView, instead of a blank white screen.
 *
 * The boundary forwards captured errors into the DebugStore (DebugStore is the
 * single source of truth for the debug timeline; see debug-store.ts).
 */

import React from "react";
import { debugStore } from "../lib/debug-store";

interface ErrorBoundaryProps {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly onReset?: () => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    debugStore.record({
      level: "error",
      source: "react",
      message: `${this.props.label}: ${error.message}`,
      stack: error.stack,
      context: { componentStack: info.componentStack ?? undefined },
    });
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  private handleOpenDebug = (): void => {
    window.location.hash = "#/studio/debug";
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        data-testid="error-boundary-card"
        style={{
          margin: "var(--sp-4)",
          maxWidth: "640px",
          padding: "var(--sp-4)",
          background: "var(--bg-raised)",
          border: "1px solid var(--accent-red)",
          color: "var(--fg-1)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            marginBottom: "var(--sp-3)",
          }}
        >
          <span
            className="badge badge-critical"
            data-pill="true"
            style={{ flexShrink: 0 }}
          >
            FAULT
          </span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "var(--text-xl)",
              fontWeight: 500,
              letterSpacing: "var(--ls-tight)",
              color: "var(--fg-1)",
            }}
          >
            {this.props.label.toUpperCase()} — RENDER FAILED
          </h2>
        </div>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            color: "var(--accent-red)",
            margin: 0,
          }}
        >
          {error.message}
        </p>
        <div
          style={{
            display: "flex",
            gap: "var(--sp-2)",
            marginTop: "var(--sp-3)",
          }}
        >
          <button
            type="button"
            onClick={this.handleReset}
            data-testid="error-boundary-retry"
            style={{
              padding: "var(--sp-1) var(--sp-3)",
              background: "var(--accent-red)",
              color: "var(--fg-inv)",
              border: "1px solid var(--accent-red)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              letterSpacing: "var(--ls-wider)",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            RETRY
          </button>
          <button
            type="button"
            onClick={this.handleOpenDebug}
            data-testid="error-boundary-debug"
            style={{
              padding: "var(--sp-1) var(--sp-3)",
              background: "transparent",
              color: "var(--accent-red)",
              border: "1px solid var(--accent-red)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              letterSpacing: "var(--ls-wider)",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            OPEN DEBUG VIEW
          </button>
        </div>
      </div>
    );
  }
}
