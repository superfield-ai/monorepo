/**
 * @file Toaster.tsx
 *
 * Renders the toast queue from toast-store.ts. Mounted once at the top level.
 * Each toast: severity-coloured card, title + message + optional action button
 * + dismiss.
 */

import React from "react";
import { toastStore, type Toast, type ToastSeverity } from "../lib/toast-store";

const SEV_CLASS: Record<ToastSeverity, string> = {
  info: "border-blue-500 bg-blue-950/80 text-blue-50",
  success: "border-emerald-500 bg-emerald-950/80 text-emerald-50",
  warn: "border-amber-500 bg-amber-950/80 text-amber-50",
  error: "border-red-600 bg-red-950/80 text-red-50",
};

export function Toaster(): JSX.Element {
  const [toasts, setToasts] = React.useState<readonly Toast[]>(() =>
    toastStore.getAll(),
  );
  React.useEffect(() => toastStore.subscribe(setToasts), []);

  return (
    <div
      data-testid="toaster"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
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
      className={`pointer-events-auto rounded border p-3 text-sm shadow-lg ${SEV_CLASS[toast.severity]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="font-medium">{toast.title}</div>
          {toast.message ? (
            <div className="mt-0.5 text-xs opacity-90">{toast.message}</div>
          ) : null}
          {toast.action ? (
            <button
              type="button"
              onClick={toast.action.onClick}
              data-testid={`toast-action-${toast.id}`}
              className="mt-2 rounded border border-current px-2 py-0.5 text-xs font-medium hover:bg-white/10"
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
          className="text-lg leading-none opacity-70 hover:opacity-100"
        >
          ×
        </button>
      </div>
    </div>
  );
}
