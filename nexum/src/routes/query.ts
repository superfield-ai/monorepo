import { route, send, readBody } from '../server.js'
import { query, queryOne } from '../db/queries.js'
import { embedTexts } from '../embed/local.js'
import { getAgePool, oneHopNeighborsFromAge } from '../db/age.js'

const queryCache = new Map<string, { embedding: number[]; expires: number }>()

async function getCachedEmbedding(text: string): Promise<number[]> {
  const cached = queryCache.get(text)
  if (cached && cached.expires > Date.now()) return cached.embedding
  const [vec] = await embedTexts([text])
  queryCache.set(text, { embedding: vec, expires: Date.now() + 60_000 })
  return vec
}

/**
 * POST /query — public query API entrypoint.
 *
 * Phase-2 contract (issue #104, implementing the scout in #113).
 *
 * Per `docs/implementation-plan.md` phase 2 and `docs/product.md` § "Query
 * API", the public Query API exposes exactly two first-class modes plus
 * their composition:
 *
 *   - `vector` — embedding-similarity search (the legacy `semantic` mode).
 *     Accepts an optional `target: 'blocks' | 'edges'` parameter; default is
 *     `blocks`. `target: 'edges'` ranks links by `links.edge_embedding`,
 *     which subsumes the legacy `edge_semantic` mode.
 *   - `graph` — typed-link traversal from a seed block.
 *   - `hybrid` — vector-ANN seed ⊕ one-hop graph expansion.
 *
 * `semantic` is accepted as a backward-compat alias for `vector`. The
 * deprecated `fulltext` and `edge_semantic` mode names are rejected with a
 * 400 pointing callers at the supported modes. The tsvector index on
 * `blocks.tsv` and the `links.edge_embedding` column survive as internal
 * signals — the `fulltextSearch()` helper below remains callable from ops
 * tooling and experiments, and `edgeSemanticSearch()` backs `target: 'edges'`.
 *
 * Public contract shape:
 *   {
 *     corpus_id: string,
 *     mode: 'graph' | 'vector' | 'hybrid',
 *     query?: string,                // required for vector + hybrid
 *     target?: 'blocks' | 'edges',   // vector only; default 'blocks'
 *     layers?: string[],             // graph + hybrid + vector(edges)
 *     seed_block_id?: string,        // required for graph
 *     max_hops?: number,             // graph only
 *     rel_types?: string[],          // graph only
 *     direction?: 'out' | 'in' | 'both', // graph only
 *     limit?: number,
 *   }
 */
const DEPRECATED_MODES = new Set(['fulltext', 'edge_semantic'])

route('POST', '/query', async (req, res) => {
  const body = await readBody(req) as any
  if (!body?.corpus_id) return send(res, 400, { error: 'corpus_id is required' })
  const mode = body.mode ?? 'semantic'
  const limit = Math.min(body.limit ?? 10, 100)

  // Reject the legacy public modes with an actionable error before any DB
  // work. The tsvector and edge-embedding columns remain available to
  // internal callers; only the public route surface is narrowed.
  if (DEPRECATED_MODES.has(mode)) {
    return send(res, 400, {
      error: `mode '${mode}' is deprecated; use mode=vector|graph|hybrid (vector accepts target=blocks|edges)`,
    })
  }

  const corpus = await queryOne('SELECT id FROM corpora WHERE id = $1', [body.corpus_id])
  if (!corpus) return send(res, 404, { error: 'corpus not found' })

  // `vector` is the phase-2 contract name; `semantic` remains accepted as a
  // backward-compat alias.
  if (mode === 'semantic' || mode === 'vector') {
    return handleVectorQuery(body, limit, res)
  }
  if (mode === 'graph') {
    return handleGraphQuery(body, limit, res)
  }
  if (mode === 'hybrid') {
    return handleHybridQuery(body, limit, res)
  }
  return send(res, 400, {
    error: `unknown mode: ${mode}; supported modes are vector, graph, hybrid`,
  })
})

/**
 * Vector-similarity query handler (phase-2 contract name for the legacy
 * `semantic` mode).
 *
 * `target` selects which embedding space to search:
 *   - `'blocks'` (default): cosine similarity over `blocks.embedding`,
 *     returning the top-K nearest blocks in the corpus.
 *   - `'edges'`: cosine similarity over `links.edge_embedding`, returning
 *     the top-K nearest typed links. Optional `layers` filters on
 *     `links.layer`. Subsumes the retired `edge_semantic` mode.
 *
 * Either a free-text `query` or, for `target: 'edges'`, a structured
 * `(src_text, dst_text, rel_hint?)` triple must be supplied. The triple is
 * embedded with the same `buildEdgeText` template the linker uses at write
 * time so probe and stored embeddings live in matching constructions.
 */
async function handleVectorQuery(body: any, limit: number, res: any) {
  const target = (body.target as 'blocks' | 'edges' | undefined) ?? 'blocks'
  if (target !== 'blocks' && target !== 'edges') {
    return send(res, 400, { error: `unknown target: ${target}; supported targets are blocks, edges` })
  }
  if (target === 'edges') {
    const hasTriple = body.src_text && body.dst_text
    if (!body.query && !hasTriple) {
      return send(res, 400, {
        error: 'query or (src_text,dst_text) is required for vector mode with target=edges',
      })
    }
    let probeText: string
    if (hasTriple) {
      const { buildEdgeText } = await import('../linker/edge-embed.js')
      probeText = buildEdgeText(body.src_text, body.dst_text, body.rel_hint ?? null)
    } else {
      probeText = body.query
    }
    const layers = body.layers as string[] | undefined
    return send(res, 200, {
      results: await edgeSemanticSearch(body.corpus_id, probeText, layers, limit),
    })
  }
  if (!body.query) return send(res, 400, { error: 'query is required for vector mode' })
  return send(res, 200, { results: await semanticSearch(body.corpus_id, body.query, limit) })
}

/**
 * Graph traversal query handler. Phase-2 first-class mode.
 *
 * Discovers blocks reachable from `seed_block_id` over the AGE link graph,
 * filtered by edge layer, rel_type, and direction. Stable seam — kept by #104.
 */
async function handleGraphQuery(body: any, limit: number, res: any) {
  if (!body.seed_block_id) return send(res, 400, { error: 'seed_block_id is required for graph mode' })
  const maxHops = body.max_hops ?? 3
  const layers = body.layers ?? ['structural', 'semantic', 'ai']
  const relTypes = body.rel_types as string[] | undefined
  const direction = (body.direction as 'out' | 'in' | 'both' | undefined) ?? 'out'
  return send(res, 200, {
    results: await graphSearch(body.seed_block_id, maxHops, layers, limit, relTypes, direction),
  })
}

/**
 * Hybrid retrieval handler — vector ANN seed ⊕ one-hop graph expansion.
 * Phase-2 first-class mode. Stable seam — kept by #104.
 */
async function handleHybridQuery(body: any, limit: number, res: any) {
  if (!body.query) return send(res, 400, { error: 'query is required for hybrid mode' })
  return send(res, 200, { results: await hybridSearch(body.corpus_id, body.query, limit) })
}

/**
 * Edge-similarity search over `links.edge_embedding`. Backs the public
 * `mode: 'vector'` + `target: 'edges'` contract (issue #104). Was previously
 * exposed as the standalone `edge_semantic` mode (#75); that public mode was
 * retired in phase-2 contract narrowing, but the underlying embedding column
 * and HNSW index remain part of the dual-write linker pipeline.
 */
async function edgeSemanticSearch(
  corpusId: string,
  probeText: string,
  layers: string[] | undefined,
  limit: number,
) {
  const vec = await getCachedEmbedding(probeText)
  const vecStr = `[${vec.join(',')}]`
  const params: any[] = [vecStr, corpusId, limit]
  let layerFilter = ''
  if (layers && layers.length > 0) {
    params.push(layers)
    layerFilter = ` AND l.layer = ANY($${params.length})`
  }
  // Both endpoint blocks must belong to documents in the requested corpus,
  // matching the corpus-scoping invariant the other modes enforce.
  const rows = await query<any>(
    `SELECT l.id AS link_id, l.layer, l.rel_type, l.weight,
            1 - (l.edge_embedding <=> $1::vector) AS score,
            sb.id AS src_block_id, sb.content AS src_content,
            db.id AS dst_block_id, db.content AS dst_content,
            sd.id AS src_doc_id, sd.title AS src_doc_title,
            dd.id AS dst_doc_id, dd.title AS dst_doc_title
     FROM links l
     JOIN blocks sb ON sb.id = l.src
     JOIN blocks db ON db.id = l.dst
     JOIN documents sd ON sd.id = sb.doc_id
     JOIN documents dd ON dd.id = db.doc_id
     WHERE l.edge_embedding IS NOT NULL
       AND sd.corpus_id = $2
       AND dd.corpus_id = $2
       ${layerFilter}
     ORDER BY l.edge_embedding <=> $1::vector
     LIMIT $3`,
    params,
  )
  return rows.map((r: any) => ({
    link_id: r.link_id,
    layer: r.layer,
    rel_type: r.rel_type,
    weight: r.weight !== null ? parseFloat(r.weight) : null,
    score: parseFloat(r.score),
    src: {
      block_id: r.src_block_id,
      content: r.src_content,
      document: { id: r.src_doc_id, title: r.src_doc_title },
    },
    dst: {
      block_id: r.dst_block_id,
      content: r.dst_content,
      document: { id: r.dst_doc_id, title: r.dst_doc_title },
    },
  }))
}

async function semanticSearch(corpusId: string, queryText: string, limit: number) {
  const vec = await getCachedEmbedding(queryText)
  const vecStr = `[${vec.join(',')}]`
  const rows = await query<any>(
    `SELECT b.id AS block_id, b.content,
            1 - (b.embedding <=> $1::vector) AS score,
            d.id AS doc_id, d.title, d.external_id
     FROM blocks b JOIN documents d ON d.id = b.doc_id
     WHERE d.corpus_id = $2 AND b.embedding IS NOT NULL
     ORDER BY b.embedding <=> $1::vector LIMIT $3`,
    [vecStr, corpusId, limit]
  )
  return rows.map((r: any) => ({
    block_id: r.block_id, content: r.content, score: parseFloat(r.score),
    document: { id: r.doc_id, title: r.title, external_id: r.external_id }
  }))
}

/**
 * Internal-only fulltext search helper. The public Query API no longer
 * exposes `mode: 'fulltext'` (issue #104), but the tsvector index on
 * `blocks.tsv` remains and this helper stays callable from ops tooling and
 * experiments (see `experiments/area1-storage-fitness`).
 */
export async function fulltextSearch(corpusId: string, queryText: string, limit: number) {
  const rows = await query<any>(
    `SELECT b.id AS block_id, b.content,
            ts_rank(b.tsv, plainto_tsquery('english', $1)) AS score,
            d.id AS doc_id, d.title, d.external_id
     FROM blocks b JOIN documents d ON d.id = b.doc_id,
          plainto_tsquery('english', $1) q
     WHERE d.corpus_id = $2 AND b.tsv @@ q
     ORDER BY score DESC LIMIT $3`,
    [queryText, corpusId, limit]
  )
  return rows.map((r: any) => ({
    block_id: r.block_id, content: r.content, score: parseFloat(r.score),
    document: { id: r.doc_id, title: r.title, external_id: r.external_id }
  }))
}

/**
 * Graph traversal via Apache AGE Cypher (issue #101).
 *
 * Replaces the pre-cutover recursive-CTE traversal over the `links` table
 * with a Cypher variable-length path query against the `nexum_links` AGE
 * graph. The behaviour contract stays identical:
 *
 *  - Discover blocks reachable from `seedBlockId` within `maxHops` edges,
 *    filtered by edge `layer` (and optionally `rel_type` and direction).
 *  - Return one row per distinct reachable block at its *minimum* depth,
 *    ordered by depth ascending, capped at `limit`.
 *  - The response shape is the same `{block_id, content, depth, rel_type,
 *    document}` object the recursive-CTE implementation produced, so
 *    consumers (including hybrid mode) need no changes.
 *
 * The recursive-CTE traversal was retired in issue #103 — AGE is the only
 * production graph-read path; no helper code remains for the legacy walk.
 *
 * Parameter inlining
 * ------------------
 * AGE's `cypher(...)` SQL function does not support bound parameters, so
 * scalar arguments are inlined into the Cypher string. Every inlined value
 * is either:
 *   - a UUID validated against the canonical 8-4-4-4-12 hex pattern, or
 *   - a member of a hard-coded whitelist (layers, direction), or
 *   - escaped (rel_types) — and every rel_type is single-quoted into a
 *     Cypher list literal, so a stray quote breaks the literal rather than
 *     escaping into the surrounding statement.
 */
async function graphSearch(
  seedBlockId: string,
  maxHops: number,
  layers: string[],
  limit: number,
  relTypes?: string[],
  direction: 'out' | 'in' | 'both' = 'out',
) {
  // Defensive validation: a malformed seed UUID would otherwise be inlined
  // into Cypher as a literal string and either silently match nothing or,
  // worse, allow injection. UUID-shaped seeds are required by the schema.
  if (!UUID_RE.test(seedBlockId)) return []
  const hops = Math.max(1, Math.min(Number(maxHops) || 1, 10))
  const safeLayers = (layers ?? []).filter((l) => ALLOWED_LAYERS.has(l))
  if (safeLayers.length === 0) return []

  const layerList = safeLayers.map((l) => `'${l}'`).join(', ')
  let relFilter = `r.layer IN [${layerList}]`
  if (relTypes && relTypes.length > 0) {
    const safeRelList = relTypes
      .map((rt) => `'${String(rt).replace(/'/g, "\\'")}'`)
      .join(', ')
    relFilter += ` AND r.rel_type IN [${safeRelList}]`
  }

  // Direction maps to Cypher edge orientation. AGE supports
  // `-[r:LINK*1..N]->` (out), `<-[r:LINK*1..N]-` (in), and
  // `-[r:LINK*1..N]-` (both / undirected).
  const arrowL = direction === 'in' ? '<-' : '-'
  const arrowR = direction === 'out' ? '->' : '-'

  // ALL(rel IN relationships(p) WHERE ...) applies the layer/rel_type
  // filter to *every* edge in the path, not just the first one — matching
  // the recursive CTE which gates each hop on `layer = ANY($2)`.
  const cypher = `
    MATCH p = (a:Block {id: '${seedBlockId}'})${arrowL}[r:LINK*1..${hops}]${arrowR}(b:Block)
    WHERE ALL(rel IN relationships(p) WHERE ${relFilter.replace(/\br\./g, 'rel.')})
    RETURN b.id AS block_id, length(p) AS depth, last(relationships(p)).rel_type AS rel_type
  `

  const pool = await getAgePool()
  let rawRows: Array<Record<string, unknown>> = []
  try {
    const result = await pool.query<{ block_id: unknown; depth: unknown; rel_type: unknown }>(
      `SELECT * FROM cypher('nexum_links', $$ ${cypher} $$) AS (block_id agtype, depth agtype, rel_type agtype)`,
    )
    rawRows = result.rows as any[]
  } catch (err) {
    console.error('graphSearch cypher failed', (err as Error).message)
    return []
  }

  // Collapse to one entry per block at minimum depth, preserving the
  // rel_type of whichever shortest-path edge was seen first. Mirrors the
  // recursive CTE's `SELECT DISTINCT ... ORDER BY g.depth`.
  const byBlock = new Map<string, { depth: number; rel_type: string | null }>()
  for (const row of rawRows) {
    const blockId = parseAgString(row.block_id)
    const depth = parseAgNumber(row.depth)
    const relType = parseAgString(row.rel_type)
    if (!blockId || depth == null) continue
    const existing = byBlock.get(blockId)
    if (!existing || depth < existing.depth) {
      byBlock.set(blockId, { depth, rel_type: relType })
    }
  }
  if (byBlock.size === 0) return []

  // Hydrate block content + document metadata from the relational store in
  // one round-trip. Sorting by depth happens client-side because Postgres
  // cannot recover the per-block depth without an extra JOIN against a
  // values list.
  const blockIds = Array.from(byBlock.keys())
  const rows = await query<any>(
    `SELECT b.id AS block_id, b.content,
            d.id AS doc_id, d.title, d.external_id
     FROM blocks b JOIN documents d ON d.id = b.doc_id
     WHERE b.id = ANY($1::uuid[])`,
    [blockIds],
  )
  const byId = new Map(rows.map((r: any) => [r.block_id, r]))
  const merged = blockIds
    .map((id) => {
      const r = byId.get(id)
      const meta = byBlock.get(id)!
      if (!r) return null
      return {
        block_id: r.block_id,
        content: r.content,
        depth: meta.depth,
        rel_type: meta.rel_type,
        document: { id: r.doc_id, title: r.title, external_id: r.external_id },
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  merged.sort((a, b) => a.depth - b.depth)
  return merged.slice(0, limit)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALLOWED_LAYERS = new Set(['structural', 'semantic', 'ai'])

/**
 * AGE returns scalar string columns as agtype, surfaced by node-postgres as
 * a JS string with the value double-quoted (e.g. `"abc-uuid"`). Strip the
 * wrapping quotes to recover the raw value. Returns null for absent values.
 */
function parseAgString(v: unknown): string | null {
  if (v == null) return null
  const s = String(v)
  if (s === 'null') return null
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  return s
}

/** AGE returns numeric columns as the number's text form, e.g. `"2"` → 2. */
function parseAgNumber(v: unknown): number | null {
  if (v == null) return null
  const s = String(v).replace(/^"|"$/g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Hybrid retrieval: vector-ANN seeding ⊕ one-hop graph expansion (issue #102).
 *
 * Architecture A2 ("hybrid = graph ⊕ vector"). After the phase-1 AGE cutover
 * the graph layer's source of truth is the `nexum_links` Apache AGE graph,
 * so the neighbour expansion runs as a single Cypher one-hop instead of the
 * legacy recursive-CTE traversal that this function previously delegated to
 * `graphSearch`.
 *
 * Pipeline:
 *   1. Vector-ANN top-K seed (unchanged) — pulls semantic-similar blocks.
 *   2. One-hop expansion through AGE Cypher across the canonical link
 *      layers (`structural`, `semantic`, `ai`). Issued as a single batched
 *      query keyed by all seed ids to keep latency O(1) round-trips.
 *   3. Enrich neighbour ids with block content from Postgres in one IN
 *      query, then merge into the result list. Semantic order is preserved
 *      first, graph neighbours appended in iteration order, and the public
 *      response shape (`block_id`, `content`, `score`/`depth`, `rel_type`,
 *      `document`, `origin`) is held stable so existing clients keep working.
 *
 * If the AGE one-hop returns nothing (e.g. the graph is empty for a brand
 * new corpus, or AGE is transiently unavailable), the response degrades to
 * the semantic-only baseline rather than failing the request.
 */
async function hybridSearch(corpusId: string, queryText: string, limit: number) {
  // Step 1: vector-ANN top-K seed (unchanged).
  const semanticResults = await semanticSearch(corpusId, queryText, 10)
  const seen = new Set<string>(semanticResults.map(r => r.block_id))
  const results: any[] = semanticResults.map(r => ({ ...r, origin: 'semantic' }))

  if (semanticResults.length === 0) return results.slice(0, limit)

  // Step 2: one-hop neighbour expansion through AGE Cypher (replaces the
  // recursive-CTE traversal). A single batched query covers every seed.
  const seedIds = semanticResults.map(r => r.block_id)
  const layers = ['structural', 'semantic', 'ai']
  const neighborMap = await oneHopNeighborsFromAge(seedIds, layers)

  // Collect unique neighbour ids in seed order; carry rel_type from the
  // first edge that introduced each neighbour to keep ordering deterministic.
  const orderedNeighbours: { blockId: string; relType: string | null }[] = []
  for (const sr of semanticResults) {
    const neighbours = neighborMap.get(sr.block_id) ?? []
    for (const n of neighbours) {
      if (seen.has(n.blockId)) continue
      seen.add(n.blockId)
      orderedNeighbours.push({ blockId: n.blockId, relType: n.relType })
    }
  }

  if (orderedNeighbours.length === 0) return results.slice(0, limit)

  // Step 3: enrich neighbour block ids with content + document metadata in
  // a single Postgres round-trip, then re-emit in graph traversal order.
  const ids = orderedNeighbours.map(n => n.blockId)
  const rows = await query<any>(
    `SELECT b.id AS block_id, b.content,
            d.id AS doc_id, d.title, d.external_id
     FROM blocks b JOIN documents d ON d.id = b.doc_id
     WHERE b.id = ANY($1)`,
    [ids]
  )
  const byId = new Map<string, any>(rows.map((r: any) => [r.block_id, r]))
  for (const n of orderedNeighbours) {
    const r = byId.get(n.blockId)
    if (!r) continue
    results.push({
      block_id: r.block_id,
      content: r.content,
      depth: 1,
      rel_type: n.relType,
      document: { id: r.doc_id, title: r.title, external_id: r.external_id },
      origin: 'graph',
    })
  }

  return results.slice(0, limit)
}
