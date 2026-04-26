/**
 * @file DebugBadge.tsx
 *
 * Top-nav "Bug" indicator (DB2). Reads the unread error/warning count from the
 * DebugStore and pulses red when > 0. Click → activates the debug tab.
 */

import React from "react";
import { debugStore } from "../lib/debug-store";

interface DebugBadgeProps {
  readonly onClick: () => void;
  readonly active: boolean;
}

export function DebugBadge({
  onClick,
  active,
}: DebugBadgeProps): JSX.Element {
  const [count, setCount] = React.useState<number>(
    () => debugStore.getState().unreadCount,
  );
  React.useEffect(
    () => debugStore.subscribe((s) => setCount(s.unreadCount)),
    [],
  );
  const has = count > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="debug-badge"
      data-active={active}
      data-count={count}
      aria-label={`Debug — ${count} unread error${count === 1 ? "" : "s"}`}
      className={`relative ml-auto mr-2 flex items-center gap-1 px-3 py-2 text-sm font-medium ${
        active
          ? "border-b-2 border-blue-400 text-blue-300"
          : has
            ? "text-red-300 hover:text-red-200"
            : "text-zinc-400 hover:text-zinc-200"
      }`}
    >
      <span>Debug</span>
      {has ? (
        <span
          data-testid="debug-badge-count"
          className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
          style={{
            animation: "pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite",
          }}
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}
