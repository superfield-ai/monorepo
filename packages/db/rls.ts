/**
 * Row-Level Security (RLS) — session workspace context wiring.
 *
 * ## Overview
 *
 * PostgreSQL RLS policies on workspace-keyed tables use the session variable
 * `app.workspace_id` to decide which rows a query may see or mutate.  Every
 * connection that touches a workspace-scoped table must set this variable
 * before executing any query against those tables.
 *
 * Typical usage in a request handler:
 *
 * ```ts
 * import { Client } from "pg";
 * import { setWorkspaceContext, clearWorkspaceContext } from "@superfield/db/rls";
 *
 * const client = new Client({ connectionString: process.env.DATABASE_URL });
 * await client.connect();
 * await setWorkspaceContext(client, workspaceId);
 * try {
 *   const rows = await client.query("SELECT * FROM sharp.repos");
 *   // rows only contains repos belonging to `workspaceId`
 * } finally {
 *   await clearWorkspaceContext(client);
 *   await client.end();
 * }
 * ```
 *
 * ## Session variable semantics
 *
 * - `SET LOCAL app.workspace_id = '…'` — scoped to the current transaction;
 *   automatically reset when the transaction ends.  Use inside transactions.
 * - `SET app.workspace_id = '…'` — scoped to the current database session;
 *   persists until explicitly cleared or the connection is closed.  Use for
 *   connection-pool connections that are not wrapped in an explicit transaction.
 *
 * ## Privileged access
 *
 * The `superfield_admin` PostgreSQL role bypasses all workspace RLS policies
 * (see `packages/db/migrations/0001_rls_workspace_isolation.sql`).  Background
 * jobs that need cross-workspace access should connect as `superfield_admin`
 * and must NOT call `setWorkspaceContext`.
 *
 * @module
 */

/**
 * Minimal interface for a PostgreSQL client that can execute a query.
 * Accepts `pg.Client`, `pg.PoolClient`, or any compatible adapter.
 */
export interface PgQueryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Thrown when `workspaceId` is missing or invalid.
 */
export class RlsContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RlsContextError";
  }
}

/**
 * Set the PostgreSQL session variable `app.workspace_id` on an existing
 * connection, scoping all subsequent queries to the given workspace.
 *
 * By default this uses `SET LOCAL` so the variable is automatically cleared
 * when the current transaction ends.  Pass `{ transaction: false }` to use
 * plain `SET` instead (session-scoped; survives transaction boundaries — use
 * with care on pooled connections).
 *
 * @param client      - A connected PostgreSQL client.
 * @param workspaceId - Non-empty workspace identifier to bind.
 * @param options     - `{ transaction?: boolean }` — defaults to `true`.
 *
 * @throws {RlsContextError} if `workspaceId` is empty or whitespace-only.
 */
export async function setWorkspaceContext(
  client: PgQueryable,
  workspaceId: string,
  options: { transaction?: boolean } = {},
): Promise<void> {
  if (!workspaceId || workspaceId.trim() === "") {
    throw new RlsContextError(
      "workspaceId must be a non-empty string to set RLS context",
    );
  }

  const local = options.transaction !== false;
  const command = local ? "SET LOCAL" : "SET";

  // PostgreSQL does not support parameterised SET statements.
  // We sanitise the value by rejecting characters outside the safe identifier
  // set (letters, digits, hyphens, underscores, dots) to prevent injection.
  // Workspace IDs are UUIDs or slug-like strings; this covers all valid cases.
  if (!/^[\w.:-]+$/.test(workspaceId)) {
    throw new RlsContextError(
      `workspaceId contains invalid characters: "${workspaceId}". ` +
        "Only word characters, dots, colons, and hyphens are permitted.",
    );
  }

  // Safe: workspaceId is validated to contain only safe characters above.
  await client.query(`${command} app.workspace_id TO '${workspaceId}'`);
}

/**
 * Clear the PostgreSQL session variable `app.workspace_id`, returning the
 * connection to an un-scoped state.
 *
 * After this call any query against an RLS-protected table will return zero
 * rows (because `current_setting('app.workspace_id', true)` returns NULL and
 * no workspace_id equals NULL).  This is the safe default — callers must
 * explicitly set the context before querying workspace-scoped tables.
 *
 * @param client - A connected PostgreSQL client.
 */
export async function clearWorkspaceContext(
  client: PgQueryable,
): Promise<void> {
  await client.query("RESET app.workspace_id");
}

/**
 * Read the workspace context that is currently set on a connection.
 *
 * Returns `null` if no workspace context has been set (the session variable
 * is absent or was cleared with `RESET`).
 *
 * @param client - A connected PostgreSQL client.
 */
export async function getWorkspaceContext(
  client: PgQueryable,
): Promise<string | null> {
  const result = (await client.query(
    "SELECT current_setting('app.workspace_id', true) AS workspace_id",
  )) as { rows: Array<{ workspace_id: string | null }> };

  const value = result.rows[0]?.workspace_id;
  // PostgreSQL returns an empty string when the setting was never set.
  return value && value !== "" ? value : null;
}

/**
 * Run a callback with the workspace context set for the duration of an
 * explicit transaction, then reset it automatically.
 *
 * Starts a transaction with `BEGIN`, sets `app.workspace_id` via `SET LOCAL`
 * (which is automatically cleared at `COMMIT`/`ROLLBACK`), calls `fn`, then
 * commits.  On error the transaction is rolled back before re-throwing.
 *
 * @param client      - A connected PostgreSQL client.
 * @param workspaceId - Non-empty workspace identifier to bind.
 * @param fn          - Callback to run inside the transaction.
 *
 * @throws {RlsContextError} if `workspaceId` is empty or whitespace-only.
 */
export async function withWorkspaceTransaction<T>(
  client: PgQueryable,
  workspaceId: string,
  fn: (client: PgQueryable) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await setWorkspaceContext(client, workspaceId, { transaction: true });
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

