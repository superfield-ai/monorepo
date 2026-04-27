/**
 * @file backend-debug-stream.ts
 *
 * Subscribes to the backend `GET /studio/debug/events` SSE endpoint and
 * forwards every emitted event into the DebugStore so the DebugView shows a
 * unified browser + backend timeline.
 *
 * Wire format (one JSON object per SSE `data:` frame):
 *
 *   { ts: number, level: "error"|"warn"|"info", source: string,
 *     message: string, stack?: string, context?: Record<string, unknown> }
 */

import { debugStore } from "./debug-store";
import type { DebugLevel } from "./debug-store";
import { openEventSource } from "./net";

interface BackendEvent {
  readonly ts?: number;
  readonly level?: DebugLevel;
  readonly source?: string;
  readonly message?: string;
  readonly stack?: string;
  readonly context?: Record<string, unknown>;
}

let handle: { close: () => void } | null = null;

export function connectBackendDebugStream(url: string): void {
  if (handle) return;
  handle = openEventSource({
    url,
    onMessage: (ev) => {
      const parsed = JSON.parse(ev.data as string) as BackendEvent;
      const level: DebugLevel =
        parsed.level === "warn" ||
        parsed.level === "info" ||
        parsed.level === "debug"
          ? parsed.level
          : "error";
      debugStore.record({
        level,
        source: "backend",
        message: parsed.message ?? "(empty backend event)",
        stack: parsed.stack,
        context: parsed.context,
      });
    },
  });
}

export function disconnectBackendDebugStream(): void {
  handle?.close();
  handle = null;
}
