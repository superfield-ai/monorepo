/**
 * @file net.ts
 *
 * Typed network wrappers around `fetch`, `EventSource`, and `WebSocket`. Every
 * call site in the webapp must use these wrappers — raw `fetch()` / `new
 * EventSource()` / `new WebSocket()` are forbidden because they bypass the
 * Result envelope and the DebugStore breadcrumb trail.
 *
 * Contracts:
 *
 *   - `fetchJson<T>(url, init?)` → `Result<T, AppError>`. Never throws. Records
 *     a breadcrumb on success, a debug entry + breadcrumb on failure.
 *   - `openEventSource({url, onMessage, onError, onOpen})` returns a handle
 *     with `.close()`. Network drops surface as `AppError` via `onError`.
 *   - `openWebSocket(...)` is the equivalent for WS streams.
 *
 * Backend `{ ok: false, error: { code, message, hint } }` envelopes are
 * detected and folded into the returned `AppError`.
 */

import { debugStore } from "./debug-store";
import type { AppError, AppErrorCode, Result } from "./errors";
import { codeForStatus, err, ok } from "./errors";

export interface FetchJsonOptions extends Omit<RequestInit, "body"> {
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

interface BackendErrorEnvelope {
  readonly ok: false;
  readonly error: { code?: string; message?: string; hint?: string };
}

function isErrorEnvelope(v: unknown): v is BackendErrorEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { ok?: unknown }).ok === false &&
    typeof (v as { error?: unknown }).error === "object"
  );
}

function recordFailure(
  error: AppError,
  source: "fetch" | "eventsource" | "websocket",
): void {
  debugStore.record({
    level: "error",
    source,
    message: error.message,
    context: {
      code: error.code,
      hint: error.hint,
      status: error.status,
      url: error.url,
    },
  });
}

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<Result<T, AppError>> {
  const { body, timeoutMs = 30_000, headers, ...rest } = options;

  const controller = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error("timeout")), timeoutMs)
      : null;

  const init: RequestInit = {
    ...rest,
    headers: new Headers(headers),
    signal: controller.signal,
  };
  if (body !== undefined) {
    if (
      body instanceof FormData ||
      body instanceof Blob ||
      typeof body === "string"
    ) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      (init.headers as Headers).set("Content-Type", "application/json");
    }
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    if (timer) clearTimeout(timer);
    const aborted = (cause as Error | undefined)?.name === "AbortError";
    const code: AppErrorCode = aborted ? "timeout" : "network";
    const error: AppError = {
      code,
      message: aborted
        ? `Request timed out after ${timeoutMs}ms`
        : `Network error: ${(cause as Error | undefined)?.message ?? "unknown"}`,
      hint: aborted
        ? "The server did not respond in time. Retry, or check your dev loop is running."
        : "The browser could not reach the server. Check your network connection.",
      url,
      cause,
    };
    recordFailure(error, "fetch");
    return err(error);
  }
  if (timer) clearTimeout(timer);

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      const error: AppError = {
        code: "parse",
        message: `Response from ${url} was not valid JSON`,
        hint: "The server returned a non-JSON body. This is a backend bug.",
        status: response.status,
        url,
        cause,
      };
      recordFailure(error, "fetch");
      return err(error);
    }
  }

  if (!response.ok) {
    const envelope = isErrorEnvelope(parsed) ? parsed.error : undefined;
    const error: AppError = {
      code:
        (envelope?.code as AppErrorCode | undefined) ??
        codeForStatus(response.status),
      message:
        envelope?.message ?? `HTTP ${response.status} ${response.statusText}`,
      hint: envelope?.hint,
      status: response.status,
      url,
    };
    recordFailure(error, "fetch");
    return err(error);
  }

  // Successful 2xx may still carry an explicit failure envelope.
  if (isErrorEnvelope(parsed)) {
    const error: AppError = {
      code: (parsed.error.code as AppErrorCode | undefined) ?? "server",
      message: parsed.error.message ?? "Server reported failure",
      hint: parsed.error.hint,
      status: response.status,
      url,
    };
    recordFailure(error, "fetch");
    return err(error);
  }

  debugStore.breadcrumb({
    category: "fetch",
    message: `${init.method ?? "GET"} ${url} → ${response.status}`,
    data: { status: response.status },
  });

  return ok(parsed as T);
}

export interface EventSourceHandle {
  readonly close: () => void;
  readonly source: EventSource;
}

export interface OpenEventSourceOptions {
  readonly url: string;
  readonly onMessage?: (ev: MessageEvent) => void;
  readonly onOpen?: () => void;
  /** Called on transport-level error. The wrapper has already recorded a debug entry. */
  readonly onError?: (error: AppError) => void;
  /** Map of named events to dispatch (in addition to default 'message'). */
  readonly events?: Record<string, (ev: MessageEvent) => void>;
}

export function openEventSource(
  opts: OpenEventSourceOptions,
): EventSourceHandle {
  const source = new EventSource(opts.url);

  if (opts.onOpen) source.addEventListener("open", () => opts.onOpen?.());
  if (opts.onMessage)
    source.addEventListener("message", (ev) =>
      opts.onMessage?.(ev as MessageEvent),
    );
  if (opts.events) {
    for (const [name, fn] of Object.entries(opts.events)) {
      source.addEventListener(name, (ev) => fn(ev as MessageEvent));
    }
  }

  source.addEventListener("error", () => {
    // EventSource auto-reconnects unless explicitly closed; only surface as a
    // user-visible error once the connection is fully closed.
    if (source.readyState === EventSource.CLOSED) {
      const error: AppError = {
        code: "network",
        message: `EventSource closed unexpectedly: ${opts.url}`,
        hint: "The server stream was disconnected. Retry to reconnect.",
        url: opts.url,
      };
      recordFailure(error, "eventsource");
      opts.onError?.(error);
    } else {
      debugStore.breadcrumb({
        category: "fetch",
        message: `EventSource transient error, will reconnect: ${opts.url}`,
      });
    }
  });

  return {
    source,
    close: () => source.close(),
  };
}

export interface WebSocketHandle {
  readonly close: (code?: number, reason?: string) => void;
  readonly send: (
    data: string | ArrayBufferLike | Blob | ArrayBufferView,
  ) => void;
  readonly socket: WebSocket;
}

export interface OpenWebSocketOptions {
  readonly url: string;
  readonly onOpen?: () => void;
  readonly onMessage?: (ev: MessageEvent) => void;
  readonly onClose?: (ev: CloseEvent) => void;
  readonly onError?: (error: AppError) => void;
}

export function openWebSocket(opts: OpenWebSocketOptions): WebSocketHandle {
  const socket = new WebSocket(opts.url);

  socket.addEventListener("open", () => {
    debugStore.breadcrumb({ category: "ws", message: `WS open ${opts.url}` });
    opts.onOpen?.();
  });
  socket.addEventListener("message", (ev) => opts.onMessage?.(ev));
  socket.addEventListener("close", (ev) => {
    debugStore.breadcrumb({
      category: "ws",
      message: `WS close ${opts.url} (${ev.code})`,
      data: { code: ev.code, reason: ev.reason, clean: ev.wasClean },
    });
    if (!ev.wasClean) {
      const error: AppError = {
        code: "network",
        message: `WebSocket closed: ${opts.url} (${ev.code})`,
        hint: "Connection dropped. The UI will attempt to reconnect.",
        url: opts.url,
      };
      recordFailure(error, "websocket");
      opts.onError?.(error);
    }
    opts.onClose?.(ev);
  });
  socket.addEventListener("error", () => {
    // The 'close' handler will record the typed AppError once readyState transitions.
    debugStore.breadcrumb({ category: "ws", message: `WS error ${opts.url}` });
  });

  return {
    socket,
    close: (code, reason) => socket.close(code, reason),
    send: (data) => socket.send(data),
  };
}
