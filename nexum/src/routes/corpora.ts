import { route, send, readBody } from '../server.js'
import { query, queryOne } from '../db/queries.js'

// POST /corpora
route('POST', '/corpora', async (req, res) => {
  const body = await readBody(req) as any
  if (!body?.name || typeof body.name !== 'string') {
    return send(res, 400, { error: 'name is required' })
  }
  const rows = await query<{ id: string; name: string; description: string | null; meta: unknown; created_at: string }>(
    `INSERT INTO corpora (name, description, meta) VALUES ($1, $2, $3) RETURNING *`,
    [body.name, body.description ?? null, body.meta ?? null]
  )
  send(res, 201, rows[0])
})

// GET /corpora/:id
route('GET', '/corpora/:id', async (req, res, params) => {
  const row = await queryOne<{ id: string; name: string; description: string | null; meta: unknown; created_at: string; document_count: number }>(
    `SELECT c.*, COUNT(d.id)::int AS document_count
     FROM corpora c
     LEFT JOIN documents d ON d.corpus_id = c.id
     WHERE c.id = $1
     GROUP BY c.id`,
    [params.id]
  )
  if (!row) return send(res, 404, { error: 'corpus not found' })
  send(res, 200, row)
})
