/**
 * GET /blocks — cursor-based block polling endpoint (issue #111).
 *
 * Returns blocks for a corpus updated after an ISO timestamp cursor, including
 * their synth_status and out-link count. Supports stable cursor-token
 * pagination. Principal corpus scope is enforced (Architecture A7).
 *
 * Query parameters
 * ----------------
 * - corpus_id (required) — filter to a single corpus
 * - since     (optional) — ISO 8601 timestamp; returns blocks with
 *                          updated_at > since. Defaults to epoch.
 * - limit     (optional) — max results per page (1–200, default 50)
 * - cursor    (optional) — opaque base64 token returned by a prior response;
 *                          takes precedence over `since` when supplied
 *
 * Cursor format
 * -------------
 * base64url( JSON({ ts: ISO, id: UUID }) )
 * where `ts` is the updated_at of the last row on the previous page and `id`
 * is its block id. This gives a stable keyset position even when rows share
 * the same updated_at timestamp.
 *
 * Response shape
 * -------------
 * {
 *   blocks: Array<{
 *     id: string,
 *     content: string,
 *     block_type: string,
 *     synth_status: string | null,
 *     origin: string,
 *     created_at: string,
 *     updated_at: string,
 *     link_count: number,   // number of outgoing links (link state summary)
 *     document: { id: string, title: string, corpus_id: string }
 *   }>,
 *   next_cursor: string | null   // null when no further pages remain
 * }
 *
 * Canonical docs
 * --------------
 * - docs/architecture.md  — API surface, corpus scope (A7)
 * - docs/implementation-plan.md — phase-4 synthesis write-back
 */

import { route, send } from '../server.js'
import { query, queryOne } from '../db/queries.js'
import { requireAuth, requireCorpusScope } from '../auth/middleware.js'
import type { IncomingMessage } from 'node:http'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  ts: string  // ISO 8601 updated_at of the last row on the previous page
  id: string  // block id of the last row (tie-breaker)
}

function encodeCursor(ts: string, id: string): string {
  const payload: CursorPayload = { ts, id }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function decodeCursor(token: string): CursorPayload | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      'ts' in parsed && typeof (parsed as any).ts === 'string' &&
      'id' in parsed && typeof (parsed as any).id === 'string'
    ) {
      return parsed as CursorPayload
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Query parameter parsing
// ---------------------------------------------------------------------------

function parseUrlParams(req: IncomingMessage): URLSearchParams {
  const rawUrl = req.url ?? '/'
  const qIdx = rawUrl.indexOf('?')
  if (qIdx === -1) return new URLSearchParams()
  return new URLSearchParams(rawUrl.slice(qIdx + 1))
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

route('GET', '/blocks', async (req, res) => {
  // Auth: require a valid principal
  const principal = await requireAuth(req)

  const params = parseUrlParams(req)
  const corpusId = params.get('corpus_id')

  if (!corpusId) {
    return send(res, 400, { error: 'corpus_id is required' })
  }

  // Corpus scope enforcement (Architecture A7)
  await requireCorpusScope(principal, corpusId, 'read')

  // Verify corpus exists
  const corpus = await queryOne<{ id: string }>('SELECT id FROM corpora WHERE id = $1', [corpusId])
  if (!corpus) {
    return send(res, 404, { error: 'corpus not found' })
  }

  // Limit
  const rawLimit = params.get('limit')
  const limit = rawLimit
    ? Math.max(1, Math.min(parseInt(rawLimit, 10) || DEFAULT_LIMIT, MAX_LIMIT))
    : DEFAULT_LIMIT

  // Cursor / since resolution
  // cursor takes precedence over since when both are supplied
  let sinceTs: string
  let sinceId: string | null = null

  const cursorToken = params.get('cursor')
  if (cursorToken) {
    const decoded = decodeCursor(cursorToken)
    if (!decoded) {
      return send(res, 400, { error: 'invalid cursor token' })
    }
    sinceTs = decoded.ts
    sinceId = decoded.id
  } else {
    const sinceParam = params.get('since')
    if (sinceParam) {
      // Validate it is a parseable date
      const d = new Date(sinceParam)
      if (isNaN(d.getTime())) {
        return send(res, 400, { error: 'since must be a valid ISO 8601 timestamp' })
      }
      sinceTs = d.toISOString()
    } else {
      sinceTs = new Date(0).toISOString() // epoch — return all blocks
    }
  }

  // Keyset pagination: fetch blocks updated after the cursor position.
  // When sinceId is set (cursor token) we use (updated_at, id) > (ts, id)
  // ordering to page deterministically even when many rows share the same
  // updated_at timestamp.
  const rows = await (sinceId
    ? query<BlockRow>(
        `SELECT
           b.id,
           b.content,
           b.block_type,
           b.synth_status,
           b.origin,
           b.created_at,
           b.updated_at,
           d.id        AS doc_id,
           d.title     AS doc_title,
           d.corpus_id AS doc_corpus_id,
           COUNT(l.id)::int AS link_count
         FROM blocks b
         JOIN documents d ON d.id = b.doc_id
         LEFT JOIN links l ON l.src = b.id
         WHERE d.corpus_id = $1
           AND (b.updated_at, b.id) > ($2::timestamptz, $3::uuid)
         GROUP BY b.id, d.id
         ORDER BY b.updated_at ASC, b.id ASC
         LIMIT $4`,
        [corpusId, sinceTs, sinceId, limit + 1],
      )
    : query<BlockRow>(
        `SELECT
           b.id,
           b.content,
           b.block_type,
           b.synth_status,
           b.origin,
           b.created_at,
           b.updated_at,
           d.id        AS doc_id,
           d.title     AS doc_title,
           d.corpus_id AS doc_corpus_id,
           COUNT(l.id)::int AS link_count
         FROM blocks b
         JOIN documents d ON d.id = b.doc_id
         LEFT JOIN links l ON l.src = b.id
         WHERE d.corpus_id = $1
           AND b.updated_at > $2::timestamptz
         GROUP BY b.id, d.id
         ORDER BY b.updated_at ASC, b.id ASC
         LIMIT $3`,
        [corpusId, sinceTs, limit + 1],
      ))

  // Determine whether there is a next page
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows

  const lastRow = pageRows[pageRows.length - 1]
  const nextCursor = hasMore && lastRow
    ? encodeCursor(lastRow.updated_at, lastRow.id)
    : null

  const blocks = pageRows.map((r) => ({
    id: r.id,
    content: r.content,
    block_type: r.block_type,
    synth_status: r.synth_status,
    origin: r.origin,
    created_at: r.created_at,
    updated_at: r.updated_at,
    link_count: r.link_count,
    document: {
      id: r.doc_id,
      title: r.doc_title,
      corpus_id: r.doc_corpus_id,
    },
  }))

  send(res, 200, { blocks, next_cursor: nextCursor })
})

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface BlockRow {
  id: string
  content: string
  block_type: string
  synth_status: string | null
  origin: string
  created_at: string
  updated_at: string
  doc_id: string
  doc_title: string
  doc_corpus_id: string
  link_count: number
}
