/**
 * Phase-2 dev-scout (issue #79): inference-client interface scaffold.
 *
 * This module defines the typed seam shared by:
 *   - #10 (Area 3: retrieval-augmented inference)
 *   - #14 (Area 2: graph-as-training-curriculum)
 *
 * It intentionally contains NO real inference logic. The runnable embedding,
 * retrieval, and scoring backends land in the downstream issues; this file
 * only fixes the interface so those issues can be developed in parallel and
 * rendezvous on a common type surface.
 *
 * Concrete backends (HTTP to a model server, in-process ORT, GPU-accelerated
 * paths via the runtime container at `docker/Dockerfile.gpu`) are added by
 * the consuming issues. The scout ships only:
 *
 *   - The `InferenceClient` interface (embed/retrieve/score).
 *   - Shared input/output value types.
 *   - A `StubInferenceClient` that throws on every call so test code that
 *     accidentally exercises the real path fails loudly rather than silently
 *     returning fake numbers.
 *
 * Canonical references:
 *   - docs/research.md (Area 2 curriculum, Area 3 retrieval-augmented
 *     inference)
 *   - docs/engineering.md (Phase-2 Scout Seams)
 */

/**
 * The retrieval mode requested by the caller.
 *
 *   - `vector`     : pure pgvector ANN over block embeddings.
 *   - `graph`      : AGE traversal over the typed-link graph from a seed set.
 *   - `hybrid`     : score = α·vector + (1-α)·graph (α set by the backend).
 *
 * The discriminator strings are fixed by the scout so #10 and #14 do not need
 * to coordinate on naming. New modes added later MUST extend this union here
 * before they are referenced elsewhere.
 */
export type RetrievalMode = 'vector' | 'graph' | 'hybrid'

/**
 * A single retrieved block with its rank-time score. `score` is opaque (any
 * monotone-with-relevance scalar); only relative order is contractually
 * meaningful across backends.
 */
export interface RetrievedBlock {
  blockId: string
  score: number
  /** Optional preview text. Backends MAY omit to save bandwidth. */
  text?: string
  meta?: Record<string, unknown>
}

/**
 * The result of a retrieval call. `mode` echoes the request so call sites can
 * persist provenance without tracking it separately.
 */
export interface RetrievalResult {
  mode: RetrievalMode
  blocks: RetrievedBlock[]
  latencyMs: number
  meta?: Record<string, unknown>
}

/**
 * Output of a relevance / faithfulness scoring pass over candidate evidence.
 * `score` is in [0, 1]; backends that cannot produce a calibrated scalar
 * should normalise on output and document the calibration in `meta`.
 */
export interface EvidenceScore {
  blockId: string
  score: number
  meta?: Record<string, unknown>
}

/**
 * The pluggable inference-client interface. Implementations are added by #10
 * and #14; the scout fixes only the surface.
 *
 * Implementors MUST be safe to call concurrently. Backends that are NOT
 * concurrency-safe (e.g. an in-process ORT session) should wrap themselves
 * in a queue and document the effective fan-out in `meta`.
 */
/**
 * Phase-3 (issue #114) addition: typed surface for AI-link classification.
 *
 * The AI linker (`src/linker/ai.ts`, ported to this seam in #106) emits a
 * relation-type label between two candidate blocks given their content and a
 * cosine-similarity prior. The string returned MUST match one of the keys in
 * `SIGNALS` (e.g. `'supports' | 'contradicts' | 'elaborates' | …`); a `null`
 * return means "no link". Backends MAY widen the label set, but downstream
 * consumers only act on labels they recognise.
 */
export interface ClassifyLinkInput {
  contentA: string
  contentB: string
  cosineSim: number
}

export interface InferenceClient {
  readonly name: string

  /**
   * Embed a single text into a fixed-dimension dense vector. Dimension is
   * backend-defined and stable for the lifetime of the client; callers SHOULD
   * read it from the first response and assert it does not change.
   */
  embed(text: string): Promise<number[]>

  /**
   * Retrieve evidence blocks for a query under the requested mode. The
   * backend is responsible for choosing concrete K / α / hop-budget; the
   * scout deliberately does NOT expose those knobs to keep the seam stable.
   */
  retrieve(query: string, mode: RetrievalMode): Promise<RetrievalResult>

  /**
   * Score a set of candidate evidence blocks against a query. Used by #10
   * for re-ranking and by #14 to convert curriculum traversals into training
   * weights. Order of returned scores MUST match the input order.
   */
  score(query: string, evidence: RetrievedBlock[]): Promise<EvidenceScore[]>

  /**
   * Classify the relation between two candidate blocks. Returns the relation
   * label (one of the `SIGNALS` keys in `src/linker/ai.ts`) or `null` if no
   * link should be produced.
   *
   * Phase-3 seam (#114): the existing `classifyPair` heuristic in
   * `src/linker/ai.ts` is the de-facto default until #106 ports the linker
   * onto this method. The synchronous heuristic can wrap itself in
   * `Promise.resolve` to satisfy the signature.
   */
  classifyLink(input: ClassifyLinkInput): Promise<string | null>
}

/**
 * Stub client used only to verify the interface compiles and is reachable
 * from tests. Every method throws so accidental use in a real code path
 * fails loudly. #10 and #14 ship the real backends behind the same
 * interface.
 */
export class StubInferenceClient implements InferenceClient {
  readonly name = 'stub-inference-client'

  embed(_text: string): Promise<number[]> {
    return Promise.reject(
      new Error(
        'StubInferenceClient.embed() is a phase-2 scout stub; wire a real ' +
          'InferenceClient (see issues #10 / #14) before calling.',
      ),
    )
  }

  retrieve(_query: string, _mode: RetrievalMode): Promise<RetrievalResult> {
    return Promise.reject(
      new Error(
        'StubInferenceClient.retrieve() is a phase-2 scout stub; wire a real ' +
          'InferenceClient (see issues #10 / #14) before calling.',
      ),
    )
  }

  score(_query: string, _evidence: RetrievedBlock[]): Promise<EvidenceScore[]> {
    return Promise.reject(
      new Error(
        'StubInferenceClient.score() is a phase-2 scout stub; wire a real ' +
          'InferenceClient (see issues #10 / #14) before calling.',
      ),
    )
  }

  classifyLink(_input: ClassifyLinkInput): Promise<string | null> {
    return Promise.reject(
      new Error(
        'StubInferenceClient.classifyLink() is a scout stub; wire a real ' +
          'InferenceClient (see issues #105 / #106) before calling.',
      ),
    )
  }
}
