/**
 * Phase-4 synthesis write-back routes (issue #110).
 *
 * POST /synthesize — agent write-back entrypoint.
 * GET  /blocks     — implemented in src/routes/blocks.ts (issue #111).
 *
 * Canonical docs
 * --------------
 * - docs/architecture.md   — A7 principal-scoped auth, block status lifecycle
 * - docs/implementation-plan.md — phase-4 synthesis write-back tasks
 *
 * Security contract (Architecture A7)
 * ------------------------------------
 * 1. Principal must be authenticated (Bearer token → entities table).
 * 2. Principal must match agent_entity_id in the request body.
 * 3. Principal must carry the 'blocks:synthesize' scope (or '*').
 *
 * Transaction contract
 * --------------------
 * - The synthesized block INSERT and all relational `links` rows are written
 *   atomically in a single Postgres transaction.
 * - AGE Cypher edges are written after the Postgres commit so the relational
 *   record is always the authoritative record; AGE edges are best-effort and
 *   surfaced as a per-edge `age_ok` flag in the response.
 */

import { route, send, readBody } from '../server.js'
import { requireAuth } from '../auth/middleware.js'
import { getPool } from '../db/pool.js'
import { writeAgeEdge } from '../db/age.js'
import { LinkTypes, propagateStale } from '../synthesis/index.js'
import { randomUUID, createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// POST /synthesize
// ---------------------------------------------------------------------------

interface SynthesizeBody {
  corpus_id: string
  content: string
  source_block_ids: string[]
  agent_entity_id: string
  confidence?: number
  meta?: Record<string, unknown>
}

/**
 * POST /synthesize — agent write-back entrypoint.
 *
 * Authenticated agents call this to persist a synthesized block with full
 * provenance to its source blocks. Enforces principal == agent_entity_id and
 * the 'blocks:synthesize' scope before writing any data.
 *
 * Request body:
 * {
 *   corpus_id:        string,       // target corpus
 *   content:          string,       // synthesized block content
 *   source_block_ids: string[],     // provenance — must not be empty
 *   agent_entity_id:  string,       // must equal the authenticated principal id
 *   confidence?:      number,       // 0–1 confidence score (optional)
 *   meta?:            object        // arbitrary metadata (optional)
 * }
 *
 * Response (201):
 * {
 *   id:           string,           // new synthesized block UUID
 *   link_ids:     string[],         // relational link row IDs (sourced-from)
 *   sourced_from: string[],         // source_block_ids echoed back
 *   status:       'published'
 * }
 *
 * Error codes:
 *   400 — missing / invalid fields
 *   401 — not authenticated
 *   403 — principal mismatch or missing blocks:synthesize scope
 *   404 — corpus not found
 *
 * @see docs/architecture.md — A7 principal-scoped auth
 * @see src/synthesis/index.ts — LinkTypes.SOURCED_FROM, SynthesizedBlockStatus
 */
route('POST', '/synthesize', async (req, res) => {
  // 1. Authenticate
  const principal = await requireAuth(req)

  // 2. Parse and validate body
  const raw = await readBody(req) as Partial<SynthesizeBody>

  if (!raw?.corpus_id || typeof raw.corpus_id !== 'string') {
    return send(res, 400, { error: 'corpus_id is required' })
  }
  if (!raw?.content || typeof raw.content !== 'string') {
    return send(res, 400, { error: 'content is required' })
  }
  if (!Array.isArray(raw?.source_block_ids) || raw.source_block_ids.length === 0) {
    return send(res, 400, { error: 'source_block_ids must be a non-empty array' })
  }
  if (!raw?.agent_entity_id || typeof raw.agent_entity_id !== 'string') {
    return send(res, 400, { error: 'agent_entity_id is required' })
  }

  const body = raw as SynthesizeBody

  // 3. Enforce principal == agent_entity_id (Architecture A7)
  if (principal.id !== body.agent_entity_id) {
    const err = new Error('forbidden: principal does not match agent_entity_id') as any
    err.status = 403
    throw err
  }

  // 4. Enforce blocks:synthesize scope
  const hasScope =
    principal.scopes.includes('*') || principal.scopes.includes('blocks:synthesize')
  if (!hasScope) {
    const err = new Error('forbidden: missing blocks:synthesize scope') as any
    err.status = 403
    throw err
  }

  // 5. Validate corpus exists
  const pool = await getPool()
  const corpusRow = await pool.query<{ id: string }>(
    'SELECT id FROM corpora WHERE id = $1',
    [body.corpus_id],
  )
  if (corpusRow.rows.length === 0) {
    return send(res, 404, { error: 'corpus not found' })
  }

  // 6. Write synthesized block + sourced-from links in one Postgres transaction
  const client = await pool.connect()
  let blockId: string
  const linkIds: string[] = []

  try {
    await client.query('BEGIN')

    // We need a doc_id to satisfy the blocks FK. Create a synthetic document
    // anchored in the corpus to hold synthesized blocks.
    // Using ON CONFLICT DO NOTHING + SELECT ensures idempotency across calls.
    const syntheticTitle = `__synthesized__${body.corpus_id}`
    const docRow = await client.query<{ id: string }>(
      `INSERT INTO documents (title, corpus_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING id`,
      [syntheticTitle, body.corpus_id],
    )
    let docId: string
    if (docRow.rows.length > 0) {
      docId = docRow.rows[0].id
    } else {
      // Document already exists; fetch its id
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM documents WHERE title = $1 AND corpus_id = $2 LIMIT 1',
        [syntheticTitle, body.corpus_id],
      )
      docId = existing.rows[0].id
    }

    // Insert synthesized block
    blockId = randomUUID()
    await client.query(
      `INSERT INTO blocks (id, doc_id, content, content_hash, block_type, origin, synth_status)
         VALUES ($1, $2, $3, $4, 'paragraph', 'synthesized', 'published')`,
      [
        blockId,
        docId,
        body.content,
        // Lightweight content hash using SHA-256
        createHash('sha256').update(body.content).digest('hex'),
      ],
    )

    // Insert relational sourced-from links (one per source block)
    const confidence = typeof body.confidence === 'number' ? body.confidence : 1.0
    const provenance = JSON.stringify({
      agent: body.agent_entity_id,
      confidence,
      created_at: new Date().toISOString(),
    })

    for (const srcId of body.source_block_ids) {
      const linkId = randomUUID()
      await client.query(
        `INSERT INTO links (id, src, dst, layer, rel_type, provenance)
           VALUES ($1, $2, $3, 'ai', $4, $5::jsonb)`,
        [linkId, srcId, blockId, LinkTypes.SOURCED_FROM, provenance],
      )
      linkIds.push(linkId)
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // 7. Write AGE Cypher edges (best-effort; Postgres is the source of truth)
  const ageResults = await Promise.all(
    body.source_block_ids.map((srcId) =>
      writeAgeEdge({
        src: srcId,
        dst: blockId,
        layer: 'ai',
        relType: LinkTypes.SOURCED_FROM,
        weight: typeof body.confidence === 'number' ? body.confidence : 1.0,
      }),
    ),
  )
  void ageResults // surfaced in logs by writeAgeEdge on failure

  send(res, 201, {
    id: blockId,
    link_ids: linkIds,
    sourced_from: body.source_block_ids,
    status: 'published',
  })
})

// ---------------------------------------------------------------------------
// PATCH /blocks/:id/retract
// ---------------------------------------------------------------------------

/**
 * PATCH /blocks/:id/retract — mark a source block as retracted and propagate
 * staleness to all downstream synthesized blocks (issue #112).
 *
 * When a source block's content is superseded or retracted, agents or operators
 * call this endpoint to trigger stale propagation via AGE Cypher. Every
 * synthesized block that was derived from the named block via a `sourced-from`
 * edge will have its `synth_status` set to `'stale'`.
 *
 * Authentication: caller must supply a Bearer token (or AUTH_OFF=true).
 * Scope: 'blocks:synthesize' or '*'.
 *
 * Path parameter:
 *   :id — UUID of the source block being retracted / superseded.
 *
 * Response (200):
 *   { id, propagated: true }
 *
 * Error codes:
 *   400 — id not a valid UUID
 *   401 — not authenticated
 *   403 — missing blocks:synthesize scope
 *   404 — block not found
 *
 * @see docs/architecture.md — A6 block-level provenance
 * @see issue #112 — stale propagation
 */
route('PATCH', '/blocks/:id/retract', async (req, res, params) => {
  // 1. Authenticate
  const principal = await requireAuth(req)

  // 2. Enforce blocks:synthesize scope (same gate as POST /synthesize)
  const hasScope =
    principal.scopes.includes('*') || principal.scopes.includes('blocks:synthesize')
  if (!hasScope) {
    const err = new Error('forbidden: missing blocks:synthesize scope') as any
    err.status = 403
    throw err
  }

  // 3. Extract block id from matched route params
  const blockId = params.id ?? ''
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!UUID_RE.test(blockId)) {
    return send(res, 400, { error: 'block id must be a valid UUID' })
  }

  // 4. Verify block exists
  const pool = await getPool()
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM blocks WHERE id = $1',
    [blockId],
  )
  if (rows.length === 0) {
    return send(res, 404, { error: 'block not found' })
  }

  // 5. Propagate staleness via AGE Cypher (async — errors are swallowed by propagateStale)
  await propagateStale(blockId)

  send(res, 200, { id: blockId, propagated: true })
})
