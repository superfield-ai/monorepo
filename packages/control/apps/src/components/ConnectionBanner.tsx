/**
 * @file ConnectionBanner.tsx
 *
 * E10 — Connection-state indicator. Polls the orchestrator status endpoint via
 * the typed `fetchJson` wrapper so any failure produces an `AppError` recorded
 * in the DebugStore. When the dev-loop API is unreachable a top-of-app banner
 * surfaces a "Start dev loop" recovery action that POSTs to /orchestrator/start.
 *
 * The component owns its own polling (independent from OrchestratorController)
 * so it works on every tab — including Studio, Preview and Debug — not just the
 * Orchestrator pillar.
 */

import React from "react";
import { fetchJson } from "../lib/net";
import type { AppError } from "../lib/errors";
import { toastStore } from "../lib/toast-store";

interface ConnectionBannerProps {
  readonly statusUrl?: string;
  readonly startUrl?: string;
  readonly pollIntervalMs?: number;
}

interface OrchestratorStatusBody {
  readonly process?: "stopped" | "starting" | "running" | "stopping";
  readonly apiReachable?: boolean;
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly process: NonNullable<OrchestratorStatusBody["process"]> }
  | { readonly kind: "unreachable"; readonly error: AppError };

export function ConnectionBanner({
  statusUrl = "/orchestrator/status",
  startUrl = "/orchestrator/start",
  pollIntervalMs = 5000,
}: ConnectionBannerProps): JSX.Element | null {
  const [state, setState] = React.useState<State>({ kind: "loading" });
  const [starting, setStarting] = React.useState(false);

  const poll = React.useCallback(async () => {
    const result = await fetchJson<OrchestratorStatusBody>(statusUrl);
    if (!result.ok) {
      setState({ kind: "unreachable", error: result.error });
      return;
    }
    setState({ kind: "ok", process: result.value.process ?? "stopped" });
  }, [statusUrl]);

  React.useEffect(() => {
    void poll();
    const id = setInterval(() => {
      void poll();
    }, pollIntervalMs);
    return () => clearInterval(id);
  }, [poll, pollIntervalMs]);

  const handleStart = React.useCallback(async () => {
    setStarting(true);
    const result = await fetchJson<{ ok?: boolean; reason?: string }>(startUrl, {
      method: "POST",
      body: {},
    });
    setStarting(false);
    if (!result.ok) {
      toastStore.show({
        severity: "error",
        title: "Could not start dev loop",
        message: result.error.message,
        timeoutMs: 6000,
      });
      return;
    }
    toastStore.show({
      severity: "success",
      title: "Dev loop starting…",
      timeoutMs: 3000,
    });
    void poll();
  }, [startUrl, poll]);

  if (state.kind !== "unreachable") return null;

  return (
    <div
      role="alert"
      data-testid="connection-banner"
      className="flex items-center gap-3 border-b border-amber-700 bg-amber-900/70 px-4 py-2 text-sm text-amber-50"
    >
      <span className="font-medium">Dev loop unreachable</span>
      <span className="text-xs opacity-80">{state.error.message}</span>
      <button
        type="button"
        data-testid="connection-banner-start"
        onClick={() => {
          void handleStart();
        }}
        disabled={starting}
        className="ml-auto rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
      >
        {starting ? "Starting…" : "Start dev loop"}
      </button>
      <button
        type="button"
        data-testid="connection-banner-retry"
        onClick={() => {
          void poll();
        }}
        className="rounded border border-amber-500 px-2 py-1 text-xs font-medium text-amber-50 hover:bg-amber-800"
      >
        Retry
      </button>
    </div>
  );
}
