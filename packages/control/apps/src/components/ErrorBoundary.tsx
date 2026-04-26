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
        className="m-4 max-w-2xl rounded border border-red-700 bg-red-950/50 p-4 text-red-100"
      >
        <h2 className="text-lg font-semibold text-red-200">
          {this.props.label} crashed
        </h2>
        <p className="mt-1 text-sm text-red-200/90">{error.message}</p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={this.handleReset}
            data-testid="error-boundary-retry"
            className="rounded bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-600"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={this.handleOpenDebug}
            data-testid="error-boundary-debug"
            className="rounded border border-red-500 px-3 py-1 text-sm font-medium text-red-100 hover:bg-red-900"
          >
            Open debug view
          </button>
        </div>
      </div>
    );
  }
}
