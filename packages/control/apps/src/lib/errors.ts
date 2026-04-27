/**
 * @file errors.ts
 *
 * Typed error contract used by every browser-side network call. The wrappers in
 * net.ts return `Result<T, AppError>` rather than throwing; call sites pattern-
 * match on `result.ok`. Backend handlers also serialise to this shape via the
 * `{ ok: false, error }` envelope produced by router-error.ts.
 */

export type AppErrorCode =
  | "network"
  | "timeout"
  | "http"
  | "parse"
  | "abort"
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "server"
  | "unsupported";

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly status?: number;
  readonly url?: string;
  readonly cause?: unknown;
}

export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function appError(input: AppError): AppError {
  return input;
}

/** Map an HTTP status to a default AppErrorCode. */
export function codeForStatus(status: number): AppErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "http";
}

/** Format an AppError for display (one line, no stack). */
export function formatAppError(error: AppError): string {
  const parts = [`[${error.code}] ${error.message}`];
  if (error.hint) parts.push(`hint: ${error.hint}`);
  if (error.status !== undefined) parts.push(`status: ${error.status}`);
  if (error.url) parts.push(`url: ${error.url}`);
  return parts.join(" — ");
}
