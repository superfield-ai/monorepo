/**
 * ConnectionPill — small status indicator for the chat WebSocket connection.
 *
 * Subscribes to a WsChatController and renders nothing while the socket is
 * idle/open. While reconnecting, shows the operator-grade
 * "LINK DEGRADED — RECONNECTING" pill. When the reconnect budget is
 * exhausted, shows "RECONNECT NOW" — the only path back to a healthy chat
 * without reloading the page.
 *
 * Visuals follow the Superfield Control Room design system: .badge with the
 * appropriate semantic tone (info / caution / critical), mono ALL-CAPS
 * labels, sharp corners on the inline button.
 */

import React, { useEffect, useState } from "react";
import {
  type WsChatController,
  type WsChatControllerState,
} from "../controllers/ChatController";

interface ConnectionPillProps {
  controller: WsChatController;
}

const dotStyle = (color: string, pulse: boolean): React.CSSProperties => ({
  height: 6,
  width: 6,
  background: color,
  borderRadius: "50%",
  flexShrink: 0,
  animation: pulse
    ? "pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite"
    : undefined,
});

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
        data-pill="true"
        className="badge badge-info"
        aria-live="polite"
        style={{ gap: 6 }}
      >
        <span aria-hidden style={dotStyle("var(--accent-blue)", true)} />
        LINK — CONNECTING
      </span>
    );
  }

  if (state.connState === "reconnecting") {
    return (
      <span
        data-testid="connection-pill"
        data-state="reconnecting"
        data-pill="true"
        className="badge badge-caution"
        aria-live="polite"
        style={{ gap: 6 }}
      >
        <span aria-hidden style={dotStyle("var(--accent-amber)", true)} />
        LINK DEGRADED — RECONNECTING (attempt {state.reconnectAttempt})
      </span>
    );
  }

  // failed
  return (
    <span
      data-testid="connection-pill"
      data-state="failed"
      data-pill="true"
      className="badge badge-critical"
      role="alert"
      style={{ gap: 6 }}
    >
      <span aria-hidden style={dotStyle("var(--accent-red)", false)} />
      LINK FAULT
      <button
        type="button"
        onClick={() => controller.reconnectNow()}
        style={{
          marginLeft: "var(--sp-2)",
          background: "transparent",
          border: "1px solid var(--accent-red)",
          color: "var(--accent-red)",
          padding: "0 var(--sp-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          letterSpacing: "var(--ls-widest)",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        RECONNECT NOW
      </button>
    </span>
  );
}
