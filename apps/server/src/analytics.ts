/**
 * Read-only SQL passthrough.
 *
 * Operator-scope endpoint that runs a single SELECT (or WITH) query
 * under a read-only transaction with `analytics_role`'s grants. The
 * statement timeout is short (5s) so a runaway query can't pin a
 * connection.
 *
 * Refuses anything that isn't a SELECT/WITH at the prefix level — a
 * shallow heuristic, not a parser, but adequate when paired with the
 * read-only transaction and role-scoped grants.
 */
import type postgres from 'postgres';

const ALLOWED_PREFIX = /^\s*(select|with)\b/i;

export interface QueryRequest {
  sql: string;
  params?: unknown[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  durationMs: number;
}

export class QueryRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'QueryRefused';
  }
}

export async function runAnalyticsQuery(
  sql: postgres.Sql,
  req: QueryRequest,
): Promise<QueryResult> {
  if (!ALLOWED_PREFIX.test(req.sql)) {
    throw new QueryRefused('only SELECT/WITH queries are allowed on the analytics endpoint');
  }
  // Multi-statement protection: a single semicolon is fine if it
  // terminates the query, but anything past it (other than whitespace) is
  // a separate statement we won't run.
  const trimmed = req.sql.trim();
  const idx = trimmed.indexOf(';');
  if (idx >= 0 && idx !== trimmed.length - 1) {
    throw new QueryRefused('multi-statement queries are not allowed');
  }
  const start = performance.now();
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe('set transaction read only');
    await tx.unsafe(`set local statement_timeout = '5s'`);
    // Switch the session role for the duration of this transaction so the
    // grants of `analytics_role` apply (which excludes api_keys and the
    // redaction audit log).
    await tx.unsafe(`set local role analytics_role`);
    return tx.unsafe(req.sql, (req.params as never[]) ?? []);
  });
  return { rows: rows as Record<string, unknown>[], durationMs: performance.now() - start };
}
