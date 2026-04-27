/**
 * @file ViewportToolbar.tsx
 *
 * Three-button viewport switcher (D4 / C-9.4). Sets the iframe width to one
 * of mobile (390), tablet (768), or desktop (1280). The chosen size is
 * persisted in localStorage under "studio.viewport" so it survives a reload.
 */

import React from "react";

export type Viewport = "mobile" | "tablet" | "desktop";

export const VIEWPORT_WIDTHS: Record<Viewport, number> = {
  mobile: 390,
  tablet: 768,
  desktop: 1280,
};

const STORAGE_KEY = "studio.viewport";

export function loadViewport(): Viewport {
  if (typeof window === "undefined") return "desktop";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "mobile" || v === "tablet" || v === "desktop") return v;
  } catch {
    // localStorage unavailable (private mode etc.) — fall through.
  }
  return "desktop";
}

export function saveViewport(v: Viewport): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, v);
  } catch {
    // Best-effort persistence.
  }
}

interface ViewportToolbarProps {
  readonly value: Viewport;
  readonly onChange: (next: Viewport) => void;
}

const LABELS: Record<Viewport, string> = {
  mobile: "MOBILE",
  tablet: "TABLET",
  desktop: "DESKTOP",
};

export function ViewportToolbar({
  value,
  onChange,
}: ViewportToolbarProps): JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="Viewport"
      data-testid="viewport-toolbar"
      style={{
        display: "flex",
        flexShrink: 0,
        alignItems: "center",
        gap: "var(--sp-1)",
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-raised)",
        padding: "var(--sp-1) var(--sp-3)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "var(--ls-wider)",
      }}
    >
      <span className="label" style={{ marginRight: "var(--sp-2)" }}>
        VIEWPORT
      </span>
      {(Object.keys(VIEWPORT_WIDTHS) as Viewport[]).map((v) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            data-testid={`viewport-${v}`}
            aria-pressed={active}
            onClick={() => onChange(v)}
            style={{
              padding: "var(--sp-1) var(--sp-2)",
              background: active ? "var(--accent-cyan)" : "transparent",
              color: active ? "var(--fg-inv)" : "var(--fg-2)",
              border: `1px solid ${active ? "var(--accent-cyan)" : "var(--border-subtle)"}`,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              fontWeight: 500,
              letterSpacing: "var(--ls-wider)",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            {LABELS[v]} ({VIEWPORT_WIDTHS[v]})
          </button>
        );
      })}
    </div>
  );
}
