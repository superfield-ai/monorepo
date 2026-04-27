/**
 * @file DebugBadge.tsx
 *
 * Top-nav "FAULT" indicator (DB2). Reads the unread error/warning count from
 * the DebugStore. Pulses the FAULT badge while > 0; renders the offline
 * variant when the queue is clean. Click → activates the debug tab.
 *
 * Visuals follow the Superfield Control Room design system: `.badge` class
 * with `badge-critical` / `badge-offline`, mono ALL-CAPS labels, sharp
 * corners. Behaviour and `data-testid` values are preserved.
 */

import React from "react";
import { debugStore } from "../lib/debug-store";

interface DebugBadgeProps {
  readonly onClick: () => void;
  readonly active: boolean;
}

export function DebugBadge({ onClick, active }: DebugBadgeProps): JSX.Element {
  const [count, setCount] = React.useState<number>(
    () => debugStore.getState().unreadCount,
  );
  React.useEffect(
    () => debugStore.subscribe((s) => setCount(s.unreadCount)),
    [],
  );
  const has = count > 0;
  const tone = has ? "badge-critical" : "badge-offline";
  const display = count > 99 ? "99+" : String(count);

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="debug-badge"
      data-active={active}
      data-count={count}
      aria-label={`Debug — ${count} unread error${count === 1 ? "" : "s"}`}
      style={{
        marginLeft: "auto",
        marginRight: "var(--sp-2)",
        background: "transparent",
        border: "none",
        padding: "var(--sp-1) var(--sp-3)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        letterSpacing: "var(--ls-widest)",
        textTransform: "uppercase",
        color: active ? "var(--accent-cyan)" : "var(--fg-2)",
        borderBottom: active
          ? "1px solid var(--accent-cyan)"
          : "1px solid transparent",
      }}
    >
      <span>DEBUG</span>
      <span
        data-testid="debug-badge-count"
        data-pill="true"
        className={`badge ${tone}`}
        style={
          has
            ? {
                animation: "pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite",
              }
            : undefined
        }
      >
        FAULT&nbsp;{display}
      </span>
    </button>
  );
}
