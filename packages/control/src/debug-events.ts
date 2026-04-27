/**
 * @file debug-events.ts
 *
 * Backend debug-event broadcaster (E7).
 *
 * Provides:
 *   - `logBackend(level, source, message, ctx?)` — record a debug event from
 *     anywhere in the studio server.
 *   - `debugEventsSseResponse()` — returns a 200 SSE Response that streams
 *     every recorded event as `data: <json>\n\n`. The browser DebugStore
 *     subscribes to GET /studio/debug/events and folds these into the unified
 *     timeline.
 *
 * The broadcaster keeps a small in-memory ring buffer (capacity 200) so a
 * client connecting late still sees recent history.
 */

export type BackendLevel = "error" | "warn" | "info" | "debug";

export interface BackendEvent {
  readonly ts: number;
  readonly level: BackendLevel;
  readonly source: string;
  readonly message: string;
  readonly stack?: string;
  readonly context?: Record<string, unknown>;
}

const RING_CAPACITY = 200;
const ring: BackendEvent[] = [];
type Subscriber = (event: BackendEvent) => void;
const subscribers = new Set<Subscriber>();

export function logBackend(
  level: BackendLevel,
  source: string,
  message: string,
  options: { stack?: string; context?: Record<string, unknown> } = {},
): void {
  const event: BackendEvent = {
    ts: Date.now(),
    level,
    source,
    message,
    stack: options.stack,
    context: options.context,
  };
  ring.push(event);
  if (ring.length > RING_CAPACITY) ring.shift();
  for (const fn of subscribers) {
    fn(event);
  }
}

export function logBackendError(err: unknown, source: string): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logBackend("error", source, message, { stack });
}

export function getRecentEvents(): readonly BackendEvent[] {
  return ring.slice();
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * Returns an SSE Response that:
 *   1. Replays the recent ring buffer immediately.
 *   2. Streams every subsequent backend debug event live.
 */
export function debugEventsSseResponse(): Response {
  // Track lifecycle state across start()/cancel() so we never enqueue or
  // close on an already-closed controller (Bun's native ReadableStream
  // throws "Invalid state: Controller is already closed", which crashes
  // Bun.serve mid-stream). The previous implementation stashed cleanup on
  // the controller but never invoked it from cancel(), leaking the
  // subscriber and ping interval — both of which then enqueued onto a
  // closed controller as soon as the client disconnected.
  let closed = false;
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Controller transitioned to closed between the check and the
          // enqueue (e.g. client aborted). Tear down so we stop trying.
          closed = true;
          cleanup?.();
          cleanup = null;
        }
      };
      const send = (event: BackendEvent): void => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        safeEnqueue(encoder.encode(data));
      };
      // Replay history.
      for (const event of ring) send(event);
      // Subscribe for live events. Unsubscribe on cancel.
      const unsub = subscribe(send);
      const ping = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 25_000);
      cleanup = () => {
        unsub();
        clearInterval(ping);
      };
    },
    cancel(reason) {
      void reason;
      closed = true;
      cleanup?.();
      cleanup = null;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** Test-only: clear the ring buffer and subscribers. */
export function __resetDebugEventsForTest(): void {
  ring.length = 0;
  subscribers.clear();
}
