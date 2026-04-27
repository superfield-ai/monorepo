/**
 * @file error-envelope.ts
 *
 * Canonical typed error envelope returned by every studio HTTP handler.
 *
 * The browser-side `fetchJson<T>` wrapper (apps/src/lib/net.ts) recognises this
 * shape and folds it into an `AppError` so the UI can pattern-match on
 * `result.ok`. The contract is a hard rule: a router never returns 5xx HTML —
 * always JSON.
 *
 * Wire format:
 *
 *   { ok: false, error: { code: string, message: string, hint?: string } }
 */

export type ErrorCode =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "server"
  | "upstream"
  | "unsupported";

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint?: string;
}

export interface ErrorEnvelope {
  readonly ok: false;
  readonly error: ErrorPayload;
}

export interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly value: T;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

const STATUS_FOR_CODE: Record<ErrorCode, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  upstream: 502,
  unsupported: 501,
  server: 500,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_FOR_CODE[code];
}

export function errorEnvelope(payload: ErrorPayload): ErrorEnvelope {
  return { ok: false, error: payload };
}

export function errorResponse(
  payload: ErrorPayload,
  init: { headers?: HeadersInit; status?: number } = {},
): Response {
  const status = init.status ?? statusForCode(payload.code);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(errorEnvelope(payload)), {
    status,
    headers,
  });
}

/**
 * Wrap an async handler so any thrown exception becomes an
 * `errorEnvelope({ code: "server", ... })` 500 response. The thrown error is
 * also forwarded to the studio debug logger via `logBackendError` so the
 * browser DebugView captures it.
 */
export function wrapHandler<Args extends unknown[]>(
  name: string,
  handler: (...args: Args) => Promise<Response>,
  onError: (err: unknown, name: string) => void,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      onError(err, name);
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse({
        code: "server",
        message: `Handler ${name} threw: ${message}`,
        hint: "This is a backend bug. Check the studio debug view for the stack trace.",
      });
    }
  };
}
