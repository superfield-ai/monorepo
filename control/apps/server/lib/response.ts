/**
 * Shared response utilities for the studio server API handlers.
 *
 * - `makeJson(corsHeaders)` — returns a factory that builds a JSON `Response`
 *   with the correct `Content-Type` header and the provided CORS headers.
 * - `readProcStdout(stdout)` — reads a Bun child-process stdout stream to a
 *   string, returning `''` for numeric file-descriptors or undefined values.
 */

/**
 * Creates a `json` response helper that captures the given CORS headers.
 *
 * Usage:
 * ```ts
 * const json = makeJson(getCorsHeaders(req));
 * return json({ error: 'Not found' }, 404);
 * ```
 */
export function makeJson(
  corsHeaders: Record<string, string>,
): (body: unknown, status?: number) => Response {
  return (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

/**
 * Reads a Bun child-process stdout stream to a UTF-8 string.
 * Returns an empty string when `stdout` is a raw file-descriptor number or
 * `undefined` (i.e. the process was not spawned with `stdout: 'pipe'`).
 */
export async function readProcStdout(
  stdout: number | ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  if (!stdout || typeof stdout === 'number') return '';
  return new Response(stdout).text();
}
