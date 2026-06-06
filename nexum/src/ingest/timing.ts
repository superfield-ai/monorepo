/**
 * Phase-1 dev-scout (issue #78): per-stage timing emitter for the ingest pipeline.
 *
 * Shared seam between:
 *   - #12 (H5.1: per-stage latency measurement)
 *   - #75 (AGE integration: edge-embedding write stage must be measurable)
 *
 * Design intent:
 *   - Cheap on the hot path (single timestamp + console.log JSON line).
 *   - No I/O fan-out (no stats flush, no DB write). #12 attaches a real sink.
 *   - Stable JSON schema so downstream parsers can be written once.
 *
 * Output schema (one JSON object per line on stdout, key `nexum_ingest_stage`):
 *   {
 *     "nexum_ingest_stage": "<stage name>",
 *     "doc_id":   "<uuid>" | null,
 *     "duration_ms": <number>,
 *     "block_count": <number> | null,
 *     "ok": true | false,
 *     "ts": "<iso8601>"
 *   }
 *
 * Canonical references:
 *   - docs/research.md (Area 5: Update Semantics; H5.1)
 *   - docs/engineering.md (Ingestion Pipeline; Phase-1 Scout Seams)
 */

/**
 * Canonical stage names. Adding a new stage requires extending this union so
 * downstream consumers (#12) can keep their stage table in lockstep.
 */
export type IngestStage =
  | 'parse'
  | 'hash'
  | 'dedup'
  | 'block_insert'
  | 'version_link'
  | 'embed'
  | 'edge_embed' // populated by #75 once edge embeddings ship
  | 'structural_link'
  | 'ai_link'

export interface StageEvent {
  nexum_ingest_stage: IngestStage
  doc_id: string | null
  duration_ms: number
  block_count: number | null
  ok: boolean
  ts: string
}

type Sink = (event: StageEvent) => void

/**
 * Default sink: a single JSON line on stdout. #12 will swap this for a
 * structured logger / stats sink without touching call sites.
 */
let sink: Sink = (event) => {
  // Single-line JSON keeps log scrapers happy.
  console.log(JSON.stringify(event))
}

/** Replace the default sink. Tests use this to capture events. */
export function setStageSink(next: Sink): void {
  sink = next
}

/** Restore stdout JSON sink. */
export function resetStageSink(): void {
  sink = (event) => console.log(JSON.stringify(event))
}

/**
 * Time `fn` and emit a StageEvent. Re-throws any error after marking ok=false.
 *
 * Usage:
 *     const blocks = await timeStage('parse', { docId }, () => parseText(content))
 */
export async function timeStage<T>(
  stage: IngestStage,
  ctx: { docId?: string | null; blockCount?: number | null },
  fn: () => Promise<T> | T,
): Promise<T> {
  const start = performance.now()
  let ok = true
  try {
    const result = await fn()
    return result
  } catch (err) {
    ok = false
    throw err
  } finally {
    const event: StageEvent = {
      nexum_ingest_stage: stage,
      doc_id: ctx.docId ?? null,
      duration_ms: performance.now() - start,
      block_count: ctx.blockCount ?? null,
      ok,
      ts: new Date().toISOString(),
    }
    try { sink(event) } catch { /* never let logging break ingest */ }
  }
}
