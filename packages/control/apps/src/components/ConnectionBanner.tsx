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
  | {
      readonly kind: "ok";
      readonly process: NonNullable<OrchestratorStatusBody["process"]>;
    }
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
    const result = await fetchJson<{ ok?: boolean; reason?: string }>(
      startUrl,
      {
        method: "POST",
        body: {},
      },
    );
    setStarting(false);
    if (!result.ok) {
      toastStore.show({
        severity: "error",
        title: "UNABLE — START DEV LOOP",
        message: result.error.message,
        timeoutMs: 6000,
      });
      return;
    }
    toastStore.show({
      severity: "success",
      title: "DEV LOOP — STARTING",
      timeoutMs: 3000,
    });
    void poll();
  }, [startUrl, poll]);

  if (state.kind !== "unreachable") return null;

  return (
    <div
      role="alert"
      data-testid="connection-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "var(--sp-2) var(--sp-4)",
        background: "rgba(212, 150, 42, 0.08)",
        borderBottom: "1px solid var(--accent-amber)",
        color: "var(--fg-1)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      }}
    >
      <span
        className="badge badge-caution"
        style={{ flexShrink: 0 }}
        data-pill="true"
      >
        DEV LOOP — OFFLINE
      </span>
      <span
        style={{
          color: "var(--fg-2)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
        }}
      >
        {state.error.message}
      </span>
      <button
        type="button"
        data-testid="connection-banner-start"
        onClick={() => {
          void handleStart();
        }}
        disabled={starting}
        style={{
          marginLeft: "auto",
          padding: "var(--sp-1) var(--sp-3)",
          background: "var(--accent-amber)",
          color: "var(--fg-inv)",
          border: "1px solid var(--accent-amber)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          fontWeight: 500,
          letterSpacing: "var(--ls-wider)",
          textTransform: "uppercase",
          cursor: starting ? "not-allowed" : "pointer",
          opacity: starting ? 0.6 : 1,
          transition: "background var(--duration-fast) var(--ease-out)",
        }}
      >
        {starting ? "STARTING…" : "START DEV LOOP"}
      </button>
      <button
        type="button"
        data-testid="connection-banner-retry"
        onClick={() => {
          void poll();
        }}
        style={{
          padding: "var(--sp-1) var(--sp-3)",
          background: "transparent",
          color: "var(--accent-amber)",
          border: "1px solid var(--accent-amber)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          fontWeight: 500,
          letterSpacing: "var(--ls-wider)",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        RETRY
      </button>
    </div>
  );
}
