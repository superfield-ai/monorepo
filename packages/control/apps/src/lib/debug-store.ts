/**
 * @file debug-store.ts
 *
 * Process-wide ring-buffer store of structured debug events captured from:
 *
 *   - `window.onerror` and `window.onunhandledrejection` handlers
 *     (see global-handlers.ts) — the safety net for truly unhandled errors.
 *   - Failed `fetch` / `EventSource` / `WebSocket` calls (see net.ts) — every
 *     I/O call returns a typed `Result<T, AppError>` and records its failure
 *     here as a side effect.
 *   - Explicit `debugStore.record(...)` calls from app code in error paths
 *     (replaces ad-hoc `console.error` calls — those would fail the
 *     `expectCleanConsole` E2E gate).
 *   - Backend `level: "error" | "warn"` events streamed over
 *     GET /studio/debug/events.
 *   - Manual breadcrumbs (route changes, successful fetches, WS messages).
 *
 * Notably the store does NOT intercept the JS `console` object. The browser
 * console remains a useful operator diagnostic surface; the
 * `expectCleanConsole` Playwright fixture enforces that no app code path
 * emits `console.error` / `console.warn` (the right fix is to handle the
 * error at its source, not silence it).
 *
 * The DebugView component (DebugView.tsx) subscribes to this store and renders a
 * unified, filterable timeline. The "Bug" badge in the top nav reads the unread
 * error/warning count.
 *
 * Capacity is 500 entries — older entries are evicted FIFO. History is mirrored to
 * sessionStorage so a page refresh does not lose context.
 *
 * No framework dependency: this module is plain TypeScript so it can be imported
 * by both React components and non-React modules.
 */

export type DebugLevel = "error" | "warn" | "info" | "debug";

export type DebugSource =
  | "console"
  | "window"
  | "fetch"
  | "eventsource"
  | "websocket"
  | "react"
  | "backend"
  | "breadcrumb";

export interface DebugContext {
  readonly url?: string;
  readonly method?: string;
  readonly status?: number;
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

export interface DebugEntry {
  readonly id: string;
  readonly ts: number;
  readonly level: DebugLevel;
  readonly source: DebugSource;
  readonly message: string;
  readonly stack?: string;
  readonly context?: DebugContext;
  readonly breadcrumbs?: readonly DebugBreadcrumb[];
}

export interface DebugBreadcrumb {
  readonly ts: number;
  readonly category: "route" | "fetch" | "ws" | "user" | "lifecycle";
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

const CAPACITY = 500;
const BREADCRUMB_CAPACITY = 50;
const STORAGE_KEY = "superfield.debugStore.v1";

type Listener = (state: DebugState) => void;

export interface DebugState {
  readonly entries: readonly DebugEntry[];
  readonly unreadCount: number;
}

let entries: DebugEntry[] = [];
let breadcrumbs: DebugBreadcrumb[] = [];
let unreadCount = 0;
const listeners = new Set<Listener>();
let nextId = 1;

const isBrowser =
  typeof window !== "undefined" && typeof sessionStorage !== "undefined";
const shouldPersistTraces =
  isBrowser &&
  (globalThis as unknown as { __superfieldPersistDebugTraces?: boolean })
    .__superfieldPersistDebugTraces === true;

interface TracePayload {
  readonly kind: "entry" | "breadcrumb";
  readonly ts: number;
  readonly level?: DebugLevel;
  readonly source?: DebugSource;
  readonly message: string;
  readonly stack?: string;
  readonly context?: DebugContext;
  readonly category?: DebugBreadcrumb["category"];
  readonly data?: Record<string, unknown>;
  readonly breadcrumbs?: readonly DebugBreadcrumb[];
}

function transmitTrace(payload: TracePayload): void {
  if (!shouldPersistTraces || typeof fetch !== "function") return;
  queueMicrotask(() => {
    void Promise.resolve(
      fetch("/studio/debug/trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }),
    ).catch(() => {});
  });
}

function snapshot(): DebugState {
  return { entries: entries.slice(), unreadCount };
}

function emit(): void {
  const state = snapshot();
  for (const fn of listeners) fn(state);
  persist();
}

function persist(): void {
  if (!isBrowser) return;
  const payload = JSON.stringify({ entries, breadcrumbs });
  try {
    sessionStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // Storage quota exceeded → drop oldest half and retry once.
    entries = entries.slice(-Math.floor(CAPACITY / 2));
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ entries, breadcrumbs }),
      );
    } catch {
      // Truly cannot persist; live state remains in memory.
    }
  }
}

function restore(): void {
  if (!isBrowser) return;
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  const parsed = JSON.parse(raw) as {
    entries?: DebugEntry[];
    breadcrumbs?: DebugBreadcrumb[];
  };
  if (Array.isArray(parsed.entries)) entries = parsed.entries.slice(-CAPACITY);
  if (Array.isArray(parsed.breadcrumbs))
    breadcrumbs = parsed.breadcrumbs.slice(-BREADCRUMB_CAPACITY);
}

restore();

export interface RecordInput {
  readonly level: DebugLevel;
  readonly source: DebugSource;
  readonly message: string;
  readonly stack?: string;
  readonly context?: DebugContext;
}

export const debugStore = {
  record(input: RecordInput): DebugEntry {
    const entry: DebugEntry = {
      id: `e${nextId++}-${Date.now().toString(36)}`,
      ts: Date.now(),
      level: input.level,
      source: input.source,
      message: input.message,
      stack: input.stack,
      context: input.context,
      breadcrumbs: breadcrumbs.slice(),
    };
    entries.push(entry);
    if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
    if (entry.level === "error" || entry.level === "warn") unreadCount += 1;
    transmitTrace({
      kind: "entry",
      ts: entry.ts,
      level: entry.level,
      source: entry.source,
      message: entry.message,
      stack: entry.stack,
      context: entry.context,
      breadcrumbs: entry.breadcrumbs,
    });
    emit();
    return entry;
  },

  breadcrumb(b: Omit<DebugBreadcrumb, "ts"> & { ts?: number }): void {
    const crumb: DebugBreadcrumb = {
      ts: b.ts ?? Date.now(),
      category: b.category,
      message: b.message,
      data: b.data,
    };
    breadcrumbs.push(crumb);
    if (breadcrumbs.length > BREADCRUMB_CAPACITY) {
      breadcrumbs.splice(0, breadcrumbs.length - BREADCRUMB_CAPACITY);
    }
    transmitTrace({
      kind: "breadcrumb",
      ts: crumb.ts,
      message: crumb.message,
      category: crumb.category,
      data: crumb.data,
      source: "breadcrumb",
      level: "debug",
    });
    persist();
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    fn(snapshot());
    return () => {
      listeners.delete(fn);
    };
  },

  getState(): DebugState {
    return snapshot();
  },

  getBreadcrumbs(): readonly DebugBreadcrumb[] {
    return breadcrumbs.slice();
  },

  markAllRead(): void {
    if (unreadCount === 0) return;
    unreadCount = 0;
    emit();
  },

  clear(): void {
    entries = [];
    breadcrumbs = [];
    unreadCount = 0;
    emit();
  },

  /** Test-only: reset all state (including listeners). */
  __resetForTest(): void {
    entries = [];
    breadcrumbs = [];
    unreadCount = 0;
    listeners.clear();
    nextId = 1;
    if (isBrowser) sessionStorage.removeItem(STORAGE_KEY);
  },
};
