/**
 * Migration runner.
 *
 * Discovers `apps/server/migrations/<NNNN>__<name>.sql`, applies pending
 * migrations in lex order, records each applied version in
 * `schema_migrations`, all inside a single transaction per file. No
 * down-migrations — moving forward only is simpler and matches the
 * superfield/template posture.
 *
 * Usage as a library:
 *   import { runMigrations } from './migrate';
 *   await runMigrations(sql);
 *
 * Usage as a CLI:
 *   bun apps/server/src/migrate.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', 'migrations');

export interface MigrationFile {
  version: string;
  name: string;
  path: string;
}

export async function discoverMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.sql')) continue;
    const m = /^(\d{4})__([a-z0-9_]+)\.sql$/.exec(entry);
    if (!m) {
      throw new Error(`unrecognized migration filename ${entry}; expected NNNN__snake_case.sql`);
    }
    out.push({ version: m[1]!, name: m[2]!, path: resolve(dir, entry) });
  }
  out.sort((a, b) => a.version.localeCompare(b.version));
  // Detect duplicate versions early.
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.version === out[i - 1]!.version) {
      throw new Error(`duplicate migration version ${out[i]!.version}`);
    }
  }
  return out;
}

async function ensureSchemaMigrationsTable(sql: postgres.Sql): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )
  `;
}

export async function appliedVersions(sql: postgres.Sql): Promise<Set<string>> {
  await ensureSchemaMigrationsTable(sql);
  const rows = await sql<{ version: string }[]>`select version from schema_migrations`;
  return new Set(rows.map((r) => r.version));
}

export interface MigrationRunResult {
  applied: MigrationFile[];
  alreadyApplied: MigrationFile[];
}

export async function runMigrations(
  sql: postgres.Sql,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationRunResult> {
  const all = await discoverMigrations(dir);
  const applied = await appliedVersions(sql);
  const alreadyApplied: MigrationFile[] = [];
  const newlyApplied: MigrationFile[] = [];

  for (const m of all) {
    if (applied.has(m.version)) {
      alreadyApplied.push(m);
      continue;
    }
    const body = await readFile(m.path, 'utf8');
    await sql.begin(async (tx) => {
      // sql.unsafe runs raw SQL; per-migration files may contain multiple
      // statements separated by semicolons. We deliberately do not split —
      // postgres lets a single Query carry multiple statements.
      await tx.unsafe(body);
      await tx`
        insert into schema_migrations (version, name) values (${m.version}, ${m.name})
      `;
    });
    newlyApplied.push(m);
  }

  return { applied: newlyApplied, alreadyApplied };
}

// CLI entry — only when invoked directly, not when imported.
if (import.meta.main) {
  const dsn = process.env.SHARP_DSN;
  if (!dsn) {
    console.error('SHARP_DSN is required');
    process.exit(2);
  }
  const sql = postgres(dsn);
  try {
    const result = await runMigrations(sql);
    console.log(
      `migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already up-to-date`,
    );
    for (const m of result.applied) console.log(`  + ${m.version}__${m.name}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}
