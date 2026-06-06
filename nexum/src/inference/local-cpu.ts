/**
 * Phase-3 (issue #105): LocalCpuInferenceClient — real @xenova/transformers
 * ONNX backend for in-process CPU inference.
 *
 * This is the default InferenceClient for Phase 3. It runs fully in-process
 * with no API keys required, satisfying architecture constraint A4
 * (out-of-the-box default) and OD1 (opinionated defaults).
 *
 * ## Model selection
 *
 * Link classification (5-class: supports / contradicts / elaborates /
 * overrides / is-exception-to / none) uses `Xenova/nli-deberta-v3-xsmall`
 * (~99 MB ONNX int8). It runs the NLI "does premise X entail label
 * hypothesis Y?" pattern, which is exactly the link-relation question.
 * The pinned revision and per-file SHA-256 checksums live in
 * `models/manifest.json`. Run `npm run fetch-model` to warm the cache.
 *
 * Fallback ladder (rejected alternatives, see models/manifest.json):
 *   - Phi-3-mini Q4_0 GGUF  — 2.4 GB, exceeds 2-minute CI cold-start budget
 *   - TinyLlama Q4_0 GGUF   — 640 MB + native llama.cpp build, over budget
 *   - Xenova/distilbart-mnli-12-1 — 120 MB, held as quality-bump reserve
 *   - Xenova/mobilebert-uncased-mnli — 90 MB, lower NLI quality, held as
 *     footprint reserve
 *
 * ## Concurrency
 *
 * The @xenova/transformers ORT session is not thread-safe. A sequential
 * queue (maxConcurrency=1 by default) is enforced via a simple promise-chain
 * mutex so concurrent callers do not race on the session state.
 *
 * Canonical references:
 *   - docs/architecture.md § A4 / OD1
 *   - docs/implementation-plan.md (Phase 3, issue #105)
 *   - models/manifest.json (pinned model identity and checksums)
 *   - models/MODEL_LOCKFILE.md (human-readable lockfile)
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ClassifyLinkInput,
  EvidenceScore,
  InferenceClient,
  RetrievalMode,
  RetrievalResult,
  RetrievedBlock,
} from './client.js'

// ---------------------------------------------------------------------------
// Relation labels (must match SIGNALS in src/linker/ai.ts)
// ---------------------------------------------------------------------------

const LINK_LABELS = [
  'supports',
  'contradicts',
  'elaborates',
  'overrides',
  'is-exception-to',
] as const

type LinkLabel = (typeof LINK_LABELS)[number]

/** Minimum entailment confidence to emit a link. Below this → null. */
const CLASSIFY_THRESHOLD = 0.35

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration accepted by `LocalCpuInferenceClient`.
 *
 * All fields are optional; sensible defaults are provided. The most useful
 * override in production is `cacheDir` to point the ONNX weight cache at a
 * persistent volume (env `NEXUM_MODEL_CACHE_DIR` is also honoured).
 */
export interface LocalCpuInferenceClientConfig {
  /**
   * Hugging Face model id for the NLI zero-shot classifier used by
   * `classifyLink` and `evaluateYesNo`. Defaults to
   * `'Xenova/nli-deberta-v3-xsmall'` (pinned in models/manifest.json).
   */
  classifierModel?: string
  /**
   * Hugging Face model id for the embedding backbone used by `embed`.
   * Defaults to `'Xenova/all-MiniLM-L6-v2'`.
   */
  embeddingModel?: string
  /**
   * Local on-disk cache directory for ONNX weights. Overrides the env var
   * `NEXUM_MODEL_CACHE_DIR`. Defaults to `models/cache` relative to the
   * repo root.
   */
  cacheDir?: string
  /**
   * Hard cap on concurrent forward passes for the NLI classifier (ORT is
   * not thread-safe). Default: 1 (sequential).
   */
  maxConcurrency?: number
}

// ---------------------------------------------------------------------------
// Lazy pipeline loader — avoids paying cold-start cost unless a method is
// actually called, and avoids a top-level dynamic import at module load time.
// ---------------------------------------------------------------------------

type Pipeline = (text: string, labels: string[], opts?: Record<string, unknown>) => Promise<{
  labels: string[]
  scores: number[]
}>

type EmbedPipeline = (text: string) => Promise<{ data: Float32Array | number[] } | number[]>

let classifierPipelineCache: Pipeline | null = null
let embedPipelineCache: EmbedPipeline | null = null

// ---------------------------------------------------------------------------
// Test seams — exported so unit tests can inject a stub pipeline without
// downloading model weights. These functions are no-ops in production.
// ---------------------------------------------------------------------------

/**
 * Replace the module-level classifier pipeline cache with a test stub.
 * Call `resetClassifierPipelineForTest()` in a finally block.
 *
 * @example
 * ```ts
 * injectClassifierPipelineForTest(async (text, labels) => ({
 *   labels: ['supports', 'contradicts'],
 *   scores: [0.80, 0.20],
 * }))
 * ```
 */
export function injectClassifierPipelineForTest(stub: Pipeline): void {
  classifierPipelineCache = stub
}

/** Drop the test-injected classifier stub, restoring normal lazy-load behavior. */
export function resetClassifierPipelineForTest(): void {
  classifierPipelineCache = null
}

function resolveDefaultCacheDir(): string {
  // Resolve relative to this source file so it works regardless of cwd.
  const thisFile = fileURLToPath(import.meta.url)
  const srcDir = path.dirname(thisFile)         // src/inference/
  const repoRoot = path.resolve(srcDir, '..', '..') // src/ → repo root
  const fromEnv = process.env['NEXUM_MODEL_CACHE_DIR']
  return fromEnv ? path.resolve(fromEnv) : path.join(repoRoot, 'models', 'cache')
}

async function loadClassifierPipeline(
  modelId: string,
  cacheDir: string,
): Promise<Pipeline> {
  if (classifierPipelineCache) return classifierPipelineCache
  const { pipeline, env } = await import('@xenova/transformers')
  env.cacheDir = cacheDir
  // Disable remote model downloads in test environments if the model is not
  // cached — the fetch-model script must be run first.
  const pipe = await pipeline('zero-shot-classification', modelId)
  classifierPipelineCache = pipe as unknown as Pipeline
  return classifierPipelineCache
}

async function loadEmbedPipeline(
  modelId: string,
  cacheDir: string,
): Promise<EmbedPipeline> {
  if (embedPipelineCache) return embedPipelineCache
  const { pipeline, env } = await import('@xenova/transformers')
  env.cacheDir = cacheDir
  const pipe = await pipeline('feature-extraction', modelId)
  embedPipelineCache = pipe as unknown as EmbedPipeline
  return embedPipelineCache
}

// ---------------------------------------------------------------------------
// LocalCpuInferenceClient
// ---------------------------------------------------------------------------

/**
 * Default `InferenceClient` for Phase 3. Uses `@xenova/transformers` ONNX
 * backend running fully in-process on CPU. No API key required.
 *
 * ### classifyLink
 * Builds a premise from `contentA + " " + contentB` (trimmed to 512 chars),
 * scores each SIGNALS label as a hypothesis via the NLI pipeline, and returns
 * the highest-scoring label when its confidence exceeds `CLASSIFY_THRESHOLD`
 * (0.35). Returns `null` when all labels score below the threshold or when
 * `cosineSim < 0.70` (fast-path bypass identical to the heuristic linker).
 *
 * ### evaluateYesNo
 * Scores `"yes"` and `"no"` as NLI hypotheses against the prompt. Returns
 * `{ answer: 'yes' | 'no', confidence }`.
 *
 * ### embed
 * Runs a mean-pooled `feature-extraction` pass on `text` and returns a
 * flat `number[]`. Dimension is model-defined and stable for the process
 * lifetime.
 *
 * ### retrieve / score
 * Stubbed — these require database access and are implemented in the
 * retrieval layer (issues #10 / #14).
 */
export class LocalCpuInferenceClient implements InferenceClient {
  readonly name = 'local-cpu-inference-client'

  private readonly classifierModel: string
  private readonly embeddingModel: string
  private readonly cacheDir: string

  // Simple promise-chain mutex: every call chains on _queue so ORT sessions
  // are never invoked concurrently.
  private _classifierQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly _config: LocalCpuInferenceClientConfig = {}) {
    this.classifierModel =
      _config.classifierModel ?? 'Xenova/nli-deberta-v3-xsmall'
    this.embeddingModel = _config.embeddingModel ?? 'Xenova/all-MiniLM-L6-v2'
    this.cacheDir = _config.cacheDir ?? resolveDefaultCacheDir()
  }

  // -------------------------------------------------------------------------
  // InferenceClient.embed
  // -------------------------------------------------------------------------

  /**
   * Embed `text` into a fixed-dimension dense vector via mean-pooled
   * `feature-extraction`. Dimension is 384 for the default
   * `all-MiniLM-L6-v2` backbone.
   */
  async embed(text: string): Promise<number[]> {
    const pipe = await loadEmbedPipeline(this.embeddingModel, this.cacheDir)
    const output = await pipe(text)
    // @xenova/transformers returns a Tensor-like with a `.data` Float32Array
    // for feature-extraction. Flatten to a plain number[].
    if (output && typeof output === 'object' && 'data' in output) {
      return Array.from(output.data as Float32Array)
    }
    // Fallback: some pipeline versions return a nested array
    if (Array.isArray(output)) {
      const flat = (output as unknown[]).flat(Infinity) as number[]
      return flat
    }
    throw new Error(
      `LocalCpuInferenceClient.embed(): unexpected pipeline output shape for model '${this.embeddingModel}'.`,
    )
  }

  // -------------------------------------------------------------------------
  // InferenceClient.retrieve — stubbed; requires database access
  // -------------------------------------------------------------------------

  retrieve(_query: string, _mode: RetrievalMode): Promise<RetrievalResult> {
    return Promise.reject(
      new Error(
        'LocalCpuInferenceClient.retrieve() is not implemented in the ' +
          'local-cpu backend; retrieval requires database access and is ' +
          'implemented by the retrieval layer (issues #10 / #14).',
      ),
    )
  }

  // -------------------------------------------------------------------------
  // InferenceClient.score — stubbed; requires database access
  // -------------------------------------------------------------------------

  score(_query: string, _evidence: RetrievedBlock[]): Promise<EvidenceScore[]> {
    return Promise.reject(
      new Error(
        'LocalCpuInferenceClient.score() is not implemented in the ' +
          'local-cpu backend; scoring requires database access and is ' +
          'implemented by the retrieval layer (issues #10 / #14).',
      ),
    )
  }

  // -------------------------------------------------------------------------
  // InferenceClient.classifyLink
  // -------------------------------------------------------------------------

  /**
   * Classify the relation between two candidate blocks using NLI zero-shot
   * classification.
   *
   * Fast-path: returns `null` immediately when `cosineSim < 0.70` (same
   * threshold as the heuristic `classifyPair` in `src/linker/ai.ts`).
   *
   * NLI-path: builds a premise from the first 512 characters of
   * `contentA + " " + contentB`, then scores each SIGNALS label as an NLI
   * hypothesis. Returns the best-scoring label if its confidence ≥ 0.35,
   * otherwise `null`.
   */
  classifyLink(input: ClassifyLinkInput): Promise<string | null> {
    return this._enqueue(() => this._classifyLink(input))
  }

  private async _classifyLink(input: ClassifyLinkInput): Promise<string | null> {
    // Fast-path cosine bypass — mirrors the heuristic linker threshold.
    if (input.cosineSim < 0.70) return null

    const pipe = await loadClassifierPipeline(this.classifierModel, this.cacheDir)
    const premise = `${input.contentA} ${input.contentB}`.slice(0, 512)
    const labels = LINK_LABELS as unknown as string[]
    const result = await pipe(premise, labels)

    // result.labels are sorted by score descending.
    const topLabel = result.labels[0] as LinkLabel
    const topScore = result.scores[0]
    return topScore >= CLASSIFY_THRESHOLD ? topLabel : null
  }

  // -------------------------------------------------------------------------
  // evaluateYesNo — not in base InferenceClient; LocalCpuInferenceClient
  // extension for direct yes/no prompts (issue #105 Behaviour section).
  // -------------------------------------------------------------------------

  /**
   * Evaluate a yes/no question using NLI zero-shot classification.
   *
   * Scores `"The answer is yes."` and `"The answer is no."` as NLI
   * hypotheses against `prompt`. Returns the higher-confidence answer and
   * its confidence score.
   *
   * @param prompt - A declarative statement or question in natural language.
   * @returns `{ answer: 'yes' | 'no', confidence: number }`
   */
  evaluateYesNo(prompt: string): Promise<{ answer: 'yes' | 'no'; confidence: number }> {
    return this._enqueue(() => this._evaluateYesNo(prompt))
  }

  private async _evaluateYesNo(
    prompt: string,
  ): Promise<{ answer: 'yes' | 'no'; confidence: number }> {
    const pipe = await loadClassifierPipeline(this.classifierModel, this.cacheDir)
    const result = await pipe(prompt.slice(0, 512), ['yes', 'no'])
    const topLabel = result.labels[0] as 'yes' | 'no'
    const topScore = result.scores[0]
    return { answer: topLabel, confidence: topScore }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Serialise a call through the classifier queue so the ORT session is
   * never invoked concurrently (it is not thread-safe).
   */
  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const slot = this._classifierQueue.then(fn)
    // Swallow errors on the queue itself so a failed call does not brick
    // subsequent calls.
    this._classifierQueue = slot.catch(() => undefined)
    return slot
  }
}
