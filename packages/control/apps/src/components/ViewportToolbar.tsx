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
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
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
      className="flex shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-3 py-1 text-xs"
    >
      <span className="mr-2 text-zinc-400">Viewport</span>
      {(Object.keys(VIEWPORT_WIDTHS) as Viewport[]).map((v) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            data-testid={`viewport-${v}`}
            aria-pressed={active}
            onClick={() => onChange(v)}
            className={
              active
                ? "rounded bg-blue-600 px-2 py-0.5 font-medium text-white"
                : "rounded px-2 py-0.5 text-zinc-300 hover:text-white"
            }
          >
            {LABELS[v]} ({VIEWPORT_WIDTHS[v]})
          </button>
        );
      })}
    </div>
  );
}
