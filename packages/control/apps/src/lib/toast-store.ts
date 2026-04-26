/**
 * @file toast-store.ts
 *
 * Process-wide toast queue. Components dispatch via `toastStore.show(...)` and
 * the <Toaster /> component subscribes for rendering. Framework-agnostic so it
 * can be called from net.ts, controllers, and React handlers alike.
 */

export type ToastSeverity = "info" | "success" | "warn" | "error";

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface Toast {
  readonly id: string;
  readonly severity: ToastSeverity;
  readonly title: string;
  readonly message?: string;
  readonly action?: ToastAction;
  readonly timeoutMs?: number;
}

type Listener = (toasts: readonly Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit(): void {
  const snapshot = toasts.slice();
  for (const fn of listeners) fn(snapshot);
}

export const toastStore = {
  show(input: Omit<Toast, "id">): string {
    const id = `t${nextId++}`;
    const toast: Toast = { ...input, id };
    toasts = [...toasts, toast];
    emit();
    if (input.timeoutMs && input.timeoutMs > 0) {
      setTimeout(() => toastStore.dismiss(id), input.timeoutMs);
    }
    return id;
  },

  dismiss(id: string): void {
    const next = toasts.filter((t) => t.id !== id);
    if (next.length === toasts.length) return;
    toasts = next;
    emit();
  },

  clear(): void {
    if (toasts.length === 0) return;
    toasts = [];
    emit();
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    fn(toasts.slice());
    return () => listeners.delete(fn);
  },

  getAll(): readonly Toast[] {
    return toasts.slice();
  },

  __resetForTest(): void {
    toasts = [];
    listeners.clear();
    nextId = 1;
  },
};
