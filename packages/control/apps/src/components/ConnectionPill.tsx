/**
 * ConnectionPill — small status indicator for the chat WebSocket connection.
 *
 * Subscribes to a WsChatController and renders nothing while the socket is
 * idle/open. While reconnecting, shows a "Reconnecting…" pill. When the
 * reconnect budget is exhausted, shows "Reconnect now" — the only path back
 * to a healthy chat without reloading the page.
 */

import React, { useEffect, useState } from "react";
import {
  WsChatController,
  type WsChatControllerState,
} from "../controllers/ChatController";

interface ConnectionPillProps {
  controller: WsChatController;
}

const baseClass =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium";

export function ConnectionPill({ controller }: ConnectionPillProps) {
  const [state, setState] = useState<WsChatControllerState>(
    controller.getState(),
  );

  useEffect(() => controller.subscribe(setState), [controller]);

  if (state.connState === "idle" || state.connState === "open") return null;

  if (state.connState === "connecting") {
    return (
      <span
        data-testid="connection-pill"
        data-state="connecting"
        className={`${baseClass} bg-gray-100 text-gray-600`}
        aria-live="polite"
      >
        <span
          aria-hidden
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400"
        />
        Connecting…
      </span>
    );
  }

  if (state.connState === "reconnecting") {
    return (
      <span
        data-testid="connection-pill"
        data-state="reconnecting"
        className={`${baseClass} bg-yellow-50 text-yellow-700`}
        aria-live="polite"
      >
        <span
          aria-hidden
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500"
        />
        Reconnecting… (attempt {state.reconnectAttempt})
      </span>
    );
  }

  // failed
  return (
    <span
      data-testid="connection-pill"
      data-state="failed"
      className={`${baseClass} bg-red-50 text-red-700`}
      role="alert"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Disconnected
      <button
        type="button"
        onClick={() => controller.reconnectNow()}
        className="ml-2 rounded border border-red-300 px-1.5 py-0.5 text-xs hover:bg-red-100"
      >
        Reconnect now
      </button>
    </span>
  );
}
