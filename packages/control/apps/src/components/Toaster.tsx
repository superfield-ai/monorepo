/**
 * @file Toaster.tsx
 *
 * Renders the toast queue from toast-store.ts. Mounted once at the top level.
 * Each toast follows the Superfield Control Room design language: a flat
 * panel on `bg-raised` with a 1px status-coloured border, mono ALL-CAPS
 * title, sentence-case sans-serif message. Sharp corners. No shadow.
 */

import React from "react";
import { toastStore, type Toast, type ToastSeverity } from "../lib/toast-store";

const SEV_BORDER: Record<ToastSeverity, string> = {
  info: "var(--accent-blue)",
  success: "var(--accent-green)",
  warn: "var(--accent-amber)",
  error: "var(--accent-red)",
};

const SEV_TINT: Record<ToastSeverity, string> = {
  info: "rgba(90,142,232,0.06)",
  success: "rgba(57,217,138,0.06)",
  warn: "rgba(212,150,42,0.06)",
  error: "rgba(212,84,122,0.06)",
};

const SEV_LABEL: Record<ToastSeverity, string> = {
  info: "INFO",
  success: "OK",
  warn: "CAUTION",
  error: "FAULT",
};

export function Toaster(): JSX.Element {
  const [toasts, setToasts] = React.useState<readonly Toast[]>(() =>
    toastStore.getAll(),
  );
  React.useEffect(() => toastStore.subscribe(setToasts), []);

  return (
    <div
      data-testid="toaster"
      style={{
        pointerEvents: "none",
        position: "fixed",
        bottom: "var(--sp-4)",
        right: "var(--sp-4)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        maxWidth: "400px",
        width: "100%",
      }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { readonly toast: Toast }): JSX.Element {
  return (
    <div
      role={
        toast.severity === "error" || toast.severity === "warn"
          ? "alert"
          : "status"
      }
      data-testid={`toast-${toast.severity}`}
      data-toast-id={toast.id}
      style={{
        pointerEvents: "auto",
        background: "var(--bg-raised)",
        border: `1px solid ${SEV_BORDER[toast.severity]}`,
        boxShadow: `inset 0 0 0 9999px ${SEV_TINT[toast.severity]}`,
        padding: "var(--sp-3)",
        color: "var(--fg-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--sp-2)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--sp-2)",
              marginBottom: "var(--sp-1)",
            }}
          >
            <span
              className={`badge badge-${
                toast.severity === "success"
                  ? "nominal"
                  : toast.severity === "warn"
                    ? "caution"
                    : toast.severity === "error"
                      ? "critical"
                      : "info"
              }`}
              data-pill="true"
            >
              {SEV_LABEL[toast.severity]}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                fontWeight: 500,
                letterSpacing: "var(--ls-wider)",
                textTransform: "uppercase",
                color: "var(--fg-1)",
              }}
            >
              {toast.title}
            </span>
          </div>
          {toast.message ? (
            <div
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-sm)",
                color: "var(--fg-2)",
                lineHeight: "var(--lh-normal)",
              }}
            >
              {toast.message}
            </div>
          ) : null}
          {toast.action ? (
            <button
              type="button"
              onClick={toast.action.onClick}
              data-testid={`toast-action-${toast.id}`}
              style={{
                marginTop: "var(--sp-2)",
                padding: "var(--sp-1) var(--sp-3)",
                background: "transparent",
                color: SEV_BORDER[toast.severity],
                border: `1px solid ${SEV_BORDER[toast.severity]}`,
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                letterSpacing: "var(--ls-wider)",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => toastStore.dismiss(toast.id)}
          data-testid={`toast-dismiss-${toast.id}`}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--fg-3)",
            fontSize: "var(--text-md)",
            lineHeight: 1,
            cursor: "pointer",
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
