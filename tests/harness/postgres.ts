/**
 * Postgres connection and per-test scratch-schema lifecycle for the Sharp lane.
 *
 * Tests that need Postgres are responsible for starting a container via
 * `pg-container.ts`'s `startPostgres()`, taking the resulting `url`, and
 * passing it to `getSql(url)`. The harness does not assume a long-running
 * Postgres exists; every test process owns its container's lifecycle.
 *
 * `SHARP_TEST_PG_DSN` is honored as an override when a developer wants to
 * point at an externally-managed Postgres (e.g., during development of a
 * tricky scenario).
 */
import postgres from 'postgres';

export type Sql = postgres.Sql;

let shared: Sql | undefined;
let sharedDsn: string | undefined;

export function getSql(dsn?: string): Sql {
  const effective = dsn ?? process.env.SHARP_TEST_PG_DSN;
  if (!effective) {
    throw new Error(
      'getSql() requires a DSN — pass one explicitly or set SHARP_TEST_PG_DSN. ' +
        'Tests that need Postgres should call startPostgres() from pg-container.ts ' +
        'and pass the resulting url here.',
    );
  }
  if (shared && sharedDsn !== effective) {
    throw new Error('getSql() called with a different DSN than the prior call in this process');
  }
  if (!shared) {
    shared = postgres(effective, {
      max: 8,
      idle_timeout: 5,
      onnotice: () => {}, // silence NOTICE chatter from CREATE/DROP SCHEMA
    });
    sharedDsn = effective;
  }
  return shared;
}

export async function closeSql(): Promise<void> {
  if (shared) {
    await shared.end({ timeout: 2 });
    shared = undefined;
    sharedDsn = undefined;
  }
}

/**
 * Create a uniquely-named scratch schema. The name is safe to interpolate
 * into DDL (lowercase letters and digits only).
 */
export async function createScratchSchema(sql: Sql): Promise<string> {
  const name = `sharp_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await sql.unsafe(`CREATE SCHEMA "${name}"`);
  return name;
}

export async function dropScratchSchema(sql: Sql, name: string): Promise<void> {
  if (!/^sharp_test_[a-z0-9]+$/.test(name)) {
    throw new Error(`refusing to drop schema with unsafe name: ${name}`);
  }
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
}

/** Convenience: create a schema, run `fn`, drop it on exit (success or failure). */
export async function withScratchSchema<T>(
  sql: Sql,
  fn: (schema: string) => Promise<T>,
): Promise<T> {
  const name = await createScratchSchema(sql);
  try {
    return await fn(name);
  } finally {
    await dropScratchSchema(sql, name);
  }
}
