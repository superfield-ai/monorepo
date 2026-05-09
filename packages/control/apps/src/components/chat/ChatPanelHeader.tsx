import type { ReactNode } from "react";

export interface ChatPanelHeaderProps {
  /** Mono ALL-CAPS label text to render */
  label: string;
  /** Optional right-side actions slot */
  actions?: ReactNode;
}

/**
 * Presentational header component for chat panels.
 * Renders a label in control-room design style with optional actions slot on the right.
 *
 * Used by ChatPanel and ProductTab to show the panel label and interactive controls.
 */
export function ChatPanelHeader({ label, actions }: ChatPanelHeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--sp-3)",
        padding: "var(--sp-3) var(--sp-4)",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
        background: "var(--bg-raised)",
      }}
    >
      <span className="label" style={{ color: "var(--fg-1)" }}>
        {label}
      </span>
      {actions && <div>{actions}</div>}
    </div>
  );
}
