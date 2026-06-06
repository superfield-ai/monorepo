/**
 * Meta sanity-check: the canary suite from TASKS.md §1.4.
 *
 * Starts an ephemeral postgres:16 container, connects, exercises the
 * scratch-schema lifecycle, stops the container. If this test cannot run,
 * no other test that needs Postgres can be trusted.
 *
 * Auto-skips when docker is unavailable so contributors without docker
 * can still run the rest of the harness's unit tests. CI sets
 * SHARP_TEST_REQUIRE_PG=1 to convert skips into hard failures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeSql,
  createScratchSchema,
  dropScratchSchema,
  getSql,
  withScratchSchema,
} from './postgres';
import { dockerAvailable, startPostgres, type PgContainer } from './pg-container';

const requirePg = process.env.SHARP_TEST_REQUIRE_PG === '1';
const explicitSkip = process.env.SHARP_TEST_SKIP_PG === '1';
let container: PgContainer | undefined;
let dockerOk = false;

beforeAll(async () => {
  if (explicitSkip) return;
  dockerOk = dockerAvailable();
  if (!dockerOk && !requirePg) return;
  if (!dockerOk && requirePg) {
    throw new Error('SHARP_TEST_REQUIRE_PG=1 but docker is unavailable');
  }
  container = await startPostgres();
}, 240_000);

afterAll(async () => {
  await closeSql();
  if (container) await container.stop();
});

describe.skipIf(explicitSkip || (!requirePg && !dockerOk))('postgres canary', () => {
  it('starts an ephemeral container and accepts a connection', () => {
    expect(container).toBeDefined();
    expect(container!.containerId).toMatch(/^[a-f0-9]{12,}$/);
    expect(container!.url).toMatch(
      /^postgres:\/\/superfield:superfield@\d+\.\d+\.\d+\.\d+:5432\/superfield$/,
    );
  });

  it('runs a trivial query', async () => {
    const sql = getSql(container!.url);
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    expect(rows[0]?.ok).toBe(1);
  });

  it('creates and drops a scratch schema', async () => {
    const sql = getSql(container!.url);
    const name = await createScratchSchema(sql);
    expect(name).toMatch(/^sharp_test_[a-z0-9]{16}$/);

    const exists = await sql<{ count: string }[]>`
      select count(*)::text as count from information_schema.schemata where schema_name = ${name}
    `;
    expect(exists[0]?.count).toBe('1');

    await dropScratchSchema(sql, name);
    const gone = await sql<{ count: string }[]>`
      select count(*)::text as count from information_schema.schemata where schema_name = ${name}
    `;
    expect(gone[0]?.count).toBe('0');
  });

  it('isolates work inside a scratch schema via withScratchSchema', async () => {
    const sql = getSql(container!.url);
    const observed = await withScratchSchema(sql, async (schema) => {
      await sql.unsafe(`CREATE TABLE "${schema}".t (id int primary key)`);
      await sql.unsafe(`INSERT INTO "${schema}".t (id) VALUES (1), (2), (3)`);
      const rows = await sql.unsafe(`SELECT count(*)::text as count FROM "${schema}".t`);
      return rows[0]?.count;
    });
    expect(observed).toBe('3');
  });

  it('refuses to drop schemas with unsafe names', async () => {
    const sql = getSql(container!.url);
    await expect(dropScratchSchema(sql, 'public')).rejects.toThrow(/unsafe name/);
    await expect(dropScratchSchema(sql, 'sharp_test_; DROP SCHEMA public')).rejects.toThrow();
  });
});
