/**
 * Phase-4 synthesis write-back seams (issue #115 dev-scout, #112 stale propagation).
 *
 * This module locks the public contract for the four phase-4 implementation
 * issues so they can develop against frozen types and function signatures
 * after the AGE cleanup in #103.
 *
 * Canonical docs
 * --------------
 * - docs/architecture.md   — graph layer design, block status lifecycle
 * - docs/implementation-plan.md — phase-4 synthesis write-back tasks
 *
 * Issue #112 — stale propagation implementation
 * ---------------------------------------------
 * `propagateStale()` walks inbound `sourced-from` edges in AGE Cypher to find
 * every synthesized block derived from the changed source block, then bulk-
 * updates their `synth_status` to `'stale'` in Postgres. AGE is the graph
 * read path; Postgres is the authoritative status store. The update is
 * idempotent — re-running against an already-stale chain produces no extra
 * writes.
 */

// ---------------------------------------------------------------------------
// Synthesized-block status enum
// ---------------------------------------------------------------------------

/**
 * Status values for a synthesized block written back by the agent layer.
 *
 * Phase-4 scout stub — values are defined here so that issues #109–#112 can
 * import the enum without circular dependencies. The database migration that
 * adds a `synthesized_status` column to `blocks` belongs to issue #109.
 *
 * @see docs/implementation-plan.md phase-4 synthesis write-back
 */
export const SynthesizedBlockStatus = {
  /** Block has been queued for synthesis but not yet processed. */
  PENDING: 'pending',
  /** Block is currently being synthesized by the agent layer. */
  SYNTHESIZING: 'synthesizing',
  /** Block has been successfully synthesized and written back. */
  DONE: 'done',
  /** Synthesis failed; the block may be retried. */
  FAILED: 'failed',
  /** Block was previously done but an upstream dependency changed; needs re-synthesis. */
  STALE: 'stale',
} as const

export type SynthesizedBlockStatusValue = typeof SynthesizedBlockStatus[keyof typeof SynthesizedBlockStatus]

// ---------------------------------------------------------------------------
// Link type registry — sourced-from constant
// ---------------------------------------------------------------------------

/**
 * Typed link type constants used throughout the graph layer.
 *
 * `SOURCED_FROM` is the canonical link type emitted by the synthesizer to
 * record which source blocks a synthesized block was derived from. Registered
 * here as a module-level constant so that the AGE write path (issue #110),
 * the stale propagation hook (issue #112), and query filters all refer to the
 * same immutable string.
 *
 * @see docs/architecture.md — Typed Link Layer
 */
export const LinkTypes = {
  /** Existing structural citation link (phase-1). */
  CITES: 'cites',
  /** Existing AI-inferred semantic links (phase-2/3). */
  SUPPORTS: 'supports',
  CONTRADICTS: 'contradicts',
  ELABORATES: 'elaborates',
  OVERRIDES: 'overrides',
  IS_EXCEPTION_TO: 'is-exception-to',
  /**
   * Phase-4: synthesized block ← source block.
   * Registered as a constant in this scout (issue #115) so #110 and #112
   * can import it without forward-declaring a raw string.
   */
  SOURCED_FROM: 'sourced-from',
} as const

export type LinkTypeValue = typeof LinkTypes[keyof typeof LinkTypes]

// ---------------------------------------------------------------------------
// Stale-propagation hook
// ---------------------------------------------------------------------------

// UUID validation pattern: canonical 8-4-4-4-12 hex form.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Propagate stale status from a changed source block to all synthesized
 * blocks derived from it via `sourced-from` edges.
 *
 * Implementation (issue #112):
 *   1. Queries AGE Cypher for direct dependents:
 *        MATCH (src:Block {id: '<sourceBlockId>'})-[r:LINK {rel_type: 'sourced-from'}]->(dep:Block)
 *        RETURN dep.id
 *   2. Bulk-updates `blocks.synth_status = 'stale'` for the returned ids in
 *      Postgres using a single UPDATE … WHERE id = ANY($1) … AND synth_status != 'stale'
 *      so already-stale rows are not re-written (idempotent).
 *
 * Design decisions:
 *   - One-hop only per the issue A6 spec ("direct dependents become stale").
 *   - AGE is the graph read path; Postgres is the authoritative status store.
 *   - If AGE is unavailable (NEXUM_REQUIRE_AGE=false in tests) or sourceBlockId
 *     is not a valid UUID, the function returns silently without error.
 *   - The Postgres UPDATE runs outside any caller transaction so it is always
 *     visible to subsequent GET /blocks polls even if the caller rolls back.
 *
 * @param sourceBlockId - UUID of the block whose content changed.
 * @returns Promise resolving when propagation is complete (or silently when
 *          AGE is unavailable / no dependents exist).
 *
 * @see docs/architecture.md — A6 block-level provenance
 * @see docs/implementation-plan.md — phase-4 stale propagation
 */
export async function propagateStale(sourceBlockId: string): Promise<void> {
  // Validate UUID before embedding in Cypher (injection guard).
  if (!UUID_RE.test(sourceBlockId)) return

  // Lazily import to avoid circular dependency at module load time.
  const { getAgePool } = await import('../db/age.js')
  const { getPool } = await import('../db/pool.js')

  // Step 1 — Ask AGE Cypher which blocks are direct dependents via sourced-from.
  let dependentIds: string[] = []
  try {
    const agePool = await getAgePool()
    const cypher = `
      MATCH (src:Block {id: '${sourceBlockId}'})-[r:LINK {rel_type: 'sourced-from'}]->(dep:Block)
      RETURN dep.id
    `
    const { rows } = await agePool.query<{ dep_id: unknown }>(
      `SELECT * FROM cypher('nexum_links', $$ ${cypher} $$) AS (dep_id agtype)`,
    )
    for (const row of rows) {
      const raw = row.dep_id
      // AGE returns string scalars quoted: "uuid-value" — strip the quotes.
      let id: string | null = null
      if (typeof raw === 'string' && raw !== 'null') {
        id = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
      }
      if (id && UUID_RE.test(id)) dependentIds.push(id)
    }
  } catch {
    // AGE unavailable or Cypher error — return silently; do not crash the caller.
    return
  }

  if (dependentIds.length === 0) return

  // Step 2 — Bulk-update synth_status in Postgres (idempotent: skip already-stale rows).
  try {
    const pool = await getPool()
    await pool.query(
      `UPDATE blocks
          SET synth_status = 'stale'
        WHERE id = ANY($1::uuid[])
          AND synth_status IS DISTINCT FROM 'stale'`,
      [dependentIds],
    )
  } catch {
    // Postgres error — log and return; do not crash the caller.
    console.error('propagateStale: Postgres update failed for source block', sourceBlockId)
  }
}
