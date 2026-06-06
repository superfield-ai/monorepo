import { readFileSync, readdirSync } from 'node:fs'
import pg from 'pg'
import { getPool } from './pool.js'
import { config } from '../config.js'
import { createCypherGraphClient, getAgePool } from './age.js'

export async function migrate() {
  const sql = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf-8')
  const pool = await getPool()
  const client = await pool.connect()
  try {
    // Split on semicolons but preserve dollar-quoted DO $$ ... $$ blocks
    const statements = splitStatements(sql)
    for (const stmt of statements) {
      const trimmed = stmt.trim()
      if (!trimmed) continue
      await client.query(trimmed)
    }
    console.log('Migration complete')
  } finally {
    client.release()
  }

  // Apply AGE-side migrations (issue #75). Only runs when AGE_DATABASE_URL is
  // configured. Each migration file is idempotent. The compose stack also
  // applies these via docker-entrypoint-initdb.d; running them here covers
  // hosted Postgres-AGE deployments that do not use the entrypoint hook and
  // also makes integration tests deterministic when they bring up an AGE
  // container after the volume is already initialized.
  await migrateAge()
  // Phase-1 AGE-default cutover (issues #98 + #100). Copy every row of the
  // primary `links` table into the `nexum_links` AGE graph as MERGE-keyed
  // LINK edges. Idempotent — safe to re-run. Aborts `migrate()` on failure
  // so operators see partial-state errors instead of a silently divergent
  // graph. No-op when AGE_DATABASE_URL is unset.
  await backfillLinksToAge()
}

/**
 * Backfill every row of the `links` table into the `nexum_links` AGE graph
 * (issue #100, phase-1 AGE-default cutover).
 *
 * Contract:
 *  - MUST be safe to call when AGE is unavailable — returns
 *    `{ ok: true, copied: 0, skipped: 'age-unavailable' }`.
 *  - MUST be idempotent — Cypher `MERGE` keyed on `link_id` collapses repeat
 *    runs to a no-op so re-running `npm run migrate` against an already
 *    backfilled graph copies zero new edges.
 *  - MUST be invoked from `migrate()` so a single `npm run migrate` is the
 *    only step an operator needs after a phase-1 deploy.
 *  - Streams rows from the primary `links` table in batches so a corpus with
 *    millions of edges does not pin them all in Node memory at once.
 *  - Errors during backfill propagate out of `migrate()` (no partial state
 *    that the caller silently swallows). The graph itself can survive a mid-
 *    run abort because every edge is MERGE-keyed on `link_id`; restarting
 *    `migrate` resumes cleanly.
 *
 * Empty-graph gate: when the AGE graph already contains at least one LINK
 * edge per links row, we skip the row scan entirely. This makes the standard
 * "migrate against a healthy database" path cheap (one `count(r)` query) while
 * still healing partial backfills if the row count and edge count diverge.
 */
export interface BackfillLinksToAgeResult {
  ok: boolean
  copied: number
  skipped?: 'age-unavailable' | 'already-backfilled'
  total?: number
}

const BACKFILL_BATCH_SIZE = 500

export interface LinkRow {
  id: string
  src: string
  dst: string
  layer: string
  rel_type: string | null
  weight: number | null
}

export async function backfillLinksToAge(): Promise<BackfillLinksToAgeResult> {
  const client = createCypherGraphClient()
  if (!(await client.available())) {
    return { ok: true, copied: 0, skipped: 'age-unavailable' }
  }

  const pool = await getPool()
  const linkCountRow = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM links`)
  const totalLinks = parseInt(linkCountRow.rows[0]?.n ?? '0', 10) || 0

  if (totalLinks === 0) {
    console.log('backfillLinksToAge: links table is empty, nothing to copy')
    return { ok: true, copied: 0, total: 0, skipped: 'already-backfilled' }
  }

  const existingEdgeCount = await client.countEdges()
  if (existingEdgeCount >= totalLinks) {
    console.log(
      `backfillLinksToAge: AGE already has ${existingEdgeCount} LINK edges (>= ${totalLinks} link rows); skipping`,
    )
    return { ok: true, copied: 0, total: totalLinks, skipped: 'already-backfilled' }
  }

  const agePool = await getAgePool()
  if (!agePool) {
    // available() returned true above; this is defensive.
    return { ok: true, copied: 0, skipped: 'age-unavailable' }
  }

  console.log(
    `backfillLinksToAge: starting (links rows=${totalLinks}, existing AGE edges=${existingEdgeCount})`,
  )

  // Stream rows with a server-side cursor so an arbitrarily large links table
  // does not have to fit in Node memory.
  const reader = await pool.connect()
  let copied = 0
  try {
    await reader.query('BEGIN')
    await reader.query(
      `DECLARE backfill_links_cur CURSOR FOR
         SELECT id::text AS id,
                src::text AS src,
                dst::text AS dst,
                layer,
                rel_type,
                weight
           FROM links
          ORDER BY created_at, id`,
    )

    while (true) {
      const batch = await reader.query<LinkRow>(
        `FETCH ${BACKFILL_BATCH_SIZE} FROM backfill_links_cur`,
      )
      if (batch.rows.length === 0) break
      for (const row of batch.rows) {
        await mergeLinkIntoAge(agePool, row)
        copied++
      }
    }

    await reader.query('CLOSE backfill_links_cur')
    await reader.query('COMMIT')
  } catch (err) {
    await reader.query('ROLLBACK').catch(() => {})
    throw new Error(
      `backfillLinksToAge failed after copying ${copied}/${totalLinks} rows: ${(err as Error).message}`,
    )
  } finally {
    reader.release()
  }

  const finalEdgeCount = await client.countEdges()
  console.log(
    `backfillLinksToAge: complete (copied=${copied}, AGE edges before=${existingEdgeCount}, after=${finalEdgeCount}, link rows=${totalLinks})`,
  )

  return { ok: true, copied, total: totalLinks }
}

/**
 * MERGE one links row into AGE as a `LINK` edge keyed on `link_id`.
 *
 * Keying the edge on the source-of-truth `links.id` (a UUID) gives an exact
 * 1:1 mapping between rows and edges, so the acceptance criterion
 * "AGE edge count == links row count" holds even when two rows happen to
 * share `(src, dst, layer, rel_type)`. Block vertices are still MERGEd so the
 * vertex set converges with the runtime edge writer (`writeAgeEdge`).
 *
 * Validation here is strict: malformed UUIDs or unknown layer values throw
 * synchronously so the surrounding `migrate()` call aborts instead of
 * silently dropping rows.
 */
async function mergeLinkIntoAge(agePool: pg.Pool, row: LinkRow): Promise<void> {
  validateLinkRow(row)
  const safeRel = (row.rel_type ?? '').replace(/'/g, "''")
  const weight = row.weight != null && Number.isFinite(row.weight) ? row.weight : 1.0
  const cypher = `
    MERGE (a:Block {id: '${row.src}'})
    MERGE (b:Block {id: '${row.dst}'})
    MERGE (a)-[r:LINK {link_id: '${row.id}'}]->(b)
    SET r.layer = '${row.layer}',
        r.rel_type = '${safeRel}',
        r.weight = ${weight}
  `
  await agePool.query(`SELECT * FROM cypher('nexum_links', $$ ${cypher} $$) AS (v agtype)`)
}

const ALLOWED_LAYERS = new Set(['structural', 'semantic', 'ai'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(s: string): boolean {
  return typeof s === 'string' && UUID_RE.test(s)
}

/**
 * Validate a single links row before it is replayed into AGE.
 *
 * Exported so unit tests can prove that malformed rows surface as backfill
 * failures (and therefore as `migrate()` failures) instead of being silently
 * skipped. The schema-level CHECK on `links.layer` makes most of these
 * impossible in practice, but the backfill is the cutover gate to AGE-default
 * reads — surfacing an error here is strictly better than producing a graph
 * that silently disagrees with the row count.
 */
export function validateLinkRow(row: LinkRow): void {
  if (!isUuid(row.id) || !isUuid(row.src) || !isUuid(row.dst)) {
    throw new Error(
      `backfill: malformed UUID in links row id=${row.id} src=${row.src} dst=${row.dst}`,
    )
  }
  if (!row.layer || !ALLOWED_LAYERS.has(row.layer)) {
    throw new Error(`backfill: invalid layer ${JSON.stringify(row.layer)} on link ${row.id}`)
  }
}

export async function migrateAge(): Promise<boolean> {
  if (!config.AGE_DATABASE_URL) return false
  const migrationsDir = new URL('../../db/migrations/', import.meta.url)
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  if (files.length === 0) return false

  const agePool = new pg.Pool({ connectionString: config.AGE_DATABASE_URL })
  try {
    const client = await agePool.connect()
    try {
      for (const file of files) {
        const sql = readFileSync(new URL(file, migrationsDir), 'utf-8')
        // AGE shim is a single DO $$ ... $$ block; pass it whole.
        await client.query(sql)
      }
      console.log(`AGE migrations applied (${files.length})`)
    } finally {
      client.release()
    }
    return true
  } catch (err) {
    console.error('AGE migration failed (continuing without AGE):', (err as Error).message)
    return false
  } finally {
    await agePool.end().catch(() => {})
  }
}

function splitStatements(sql: string): string[] {
  const stmts: string[] = []
  let current = ''
  let inDollarQuote = false
  let dollarTag = ''
  let inLineComment = false

  let i = 0
  while (i < sql.length) {
    // Handle newline: ends a line comment
    if (sql[i] === '\n') {
      inLineComment = false
      current += sql[i]
      i++
      continue
    }

    // Inside a line comment: copy characters verbatim until newline
    if (inLineComment) {
      current += sql[i]
      i++
      continue
    }

    // Detect start of a line comment (-- ...) when not inside a dollar-quoted block
    if (!inDollarQuote && sql[i] === '-' && sql[i + 1] === '-') {
      inLineComment = true
      current += sql[i]
      i++
      continue
    }

    // Detect start/end of dollar-quoted strings
    if (!inDollarQuote && sql[i] === '$') {
      const end = sql.indexOf('$', i + 1)
      if (end !== -1) {
        const tag = sql.slice(i, end + 1)
        if (/^\$[A-Za-z0-9_]*\$$/.test(tag)) {
          inDollarQuote = true
          dollarTag = tag
          current += sql.slice(i, end + 1)
          i = end + 1
          continue
        }
      }
    } else if (inDollarQuote && sql.startsWith(dollarTag, i)) {
      current += dollarTag
      i += dollarTag.length
      inDollarQuote = false
      dollarTag = ''
      continue
    }

    if (!inDollarQuote && sql[i] === ';') {
      stmts.push(current)
      current = ''
    } else {
      current += sql[i]
    }
    i++
  }
  if (current.trim()) stmts.push(current)
  return stmts
}

// Allow running as a script: tsx src/db/migrate.ts
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
}
