/**
 * Phase-3 (issue #108): OpenAI hosted-provider adapter.
 *
 * Opt-in only. Architecture constraint A4 keeps the local CPU model as the
 * default; this adapter exists so users with `OPENAI_API_KEY` can swap to
 * OpenAI for `embed` / `score` / `classifyLink` quality without changing
 * call sites.
 *
 * ## Opt-in usage
 *
 * ```bash
 * NEXUM_INFERENCE_BACKEND=openai OPENAI_API_KEY=sk-… node …
 * ```
 *
 * The adapter reads its API key from `process.env.OPENAI_API_KEY` at
 * construction time (or from the `apiKey` config field). If neither is
 * present, every method that calls the API rejects with a clear error
 * message — no silent fallback to the local-CPU path.
 *
 * ## Method behaviour
 *
 * - **embed**: calls the OpenAI Embeddings API (`text-embedding-3-small` by
 *   default) and returns a flat `number[]`. Dimension is 1536 for the default
 *   model.
 * - **classifyLink**: sends `contentA` and `contentB` to the Chat Completions
 *   API with a structured prompt asking for a SIGNALS relation label. Returns
 *   one of (`supports | contradicts | elaborates | overrides |
 *   is-exception-to`) or `null`.
 * - **score**: uses Chat Completions to rate each block's relevance to the
 *   query and returns normalised [0,1] scores.
 * - **retrieve**: requires database access; rejects with an explanatory error.
 *   The retrieval layer (issues #10/#14) owns this path.
 *
 * ## Tests
 *
 * Tests run without an API key by injecting stubs via
 * `injectOpenAiChatFetchForTest` / `injectOpenAiEmbedFetchForTest`. See the
 * test seam functions below.
 *
 * Canonical references:
 *   - docs/architecture.md § A3 / A4 / OD4
 *   - docs/implementation-plan.md (Phase 3, issue #108)
 *   - src/inference/index.ts (backend selection via NEXUM_INFERENCE_BACKEND)
 */

import type {
  ClassifyLinkInput,
  EvidenceScore,
  InferenceClient,
  RetrievalMode,
  RetrievalResult,
  RetrievedBlock,
} from '../client.js'

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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OpenAiInferenceClientConfig {
  /** OpenAI API key. Falls back to `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  /**
   * Model for text embedding. Defaults to `'text-embedding-3-small'`
   * (1536-dimensional, lowest cost). Use `'text-embedding-3-large'` for
   * 3072-dimensional higher-quality embeddings.
   */
  embeddingModel?: string
  /**
   * Model for chat completions (classifyLink, score). Defaults to
   * `'gpt-4o-mini'` (low latency / cost; swap for `'gpt-4o'` for higher
   * quality).
   */
  chatModel?: string
  /**
   * Base URL for the OpenAI API. Defaults to `'https://api.openai.com'`.
   * Override in tests to point at a local stub server.
   */
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// Test seams — module-level fetch overrides so tests can inject responses
// without a real API key.
// ---------------------------------------------------------------------------

type ChatFetch = (
  url: string,
  body: unknown,
  apiKey: string,
) => Promise<{ choices: Array<{ message: { content: string } }> }>

type EmbedFetch = (
  url: string,
  body: unknown,
  apiKey: string,
) => Promise<{ data: Array<{ embedding: number[] }> }>

let _chatFetchOverride: ChatFetch | null = null
let _embedFetchOverride: EmbedFetch | null = null

/**
 * Replace the OpenAI Chat Completions fetch with a test stub. Call
 * `resetOpenAiChatFetchForTest()` in a finally block.
 *
 * @example
 * ```ts
 * injectOpenAiChatFetchForTest(async (_url, _body, _key) => ({
 *   choices: [{ message: { content: 'supports' } }],
 * }))
 * ```
 */
export function injectOpenAiChatFetchForTest(stub: ChatFetch): void {
  _chatFetchOverride = stub
}

/** Drop the injected chat stub, restoring real API calls. */
export function resetOpenAiChatFetchForTest(): void {
  _chatFetchOverride = null
}

/**
 * Replace the OpenAI Embeddings fetch with a test stub. Call
 * `resetOpenAiEmbedFetchForTest()` in a finally block.
 *
 * @example
 * ```ts
 * injectOpenAiEmbedFetchForTest(async (_url, _body, _key) => ({
 *   data: [{ embedding: [0.1, 0.2, 0.3] }],
 * }))
 * ```
 */
export function injectOpenAiEmbedFetchForTest(stub: EmbedFetch): void {
  _embedFetchOverride = stub
}

/** Drop the injected embed stub, restoring real API calls. */
export function resetOpenAiEmbedFetchForTest(): void {
  _embedFetchOverride = null
}

// ---------------------------------------------------------------------------
// OpenAiInferenceClient
// ---------------------------------------------------------------------------

/**
 * Opt-in `InferenceClient` backed by the OpenAI API.
 *
 * Select via `NEXUM_INFERENCE_BACKEND=openai`. Requires `OPENAI_API_KEY`
 * (or `config.apiKey`) to be set before any method that calls the API is
 * invoked.
 */
export class OpenAiInferenceClient implements InferenceClient {
  readonly name = 'openai-inference-client'

  private readonly apiKey: string
  private readonly embeddingModel: string
  private readonly chatModel: string
  private readonly baseUrl: string

  constructor(config: OpenAiInferenceClientConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? ''
    this.embeddingModel = config.embeddingModel ?? 'text-embedding-3-small'
    this.chatModel = config.chatModel ?? 'gpt-4o-mini'
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com'
  }

  // -------------------------------------------------------------------------
  // InferenceClient.embed
  // -------------------------------------------------------------------------

  /**
   * Embed `text` using the OpenAI Embeddings API. Returns a flat `number[]`
   * whose length is determined by `embeddingModel` (1536 for
   * `text-embedding-3-small`).
   *
   * Requires `OPENAI_API_KEY` (or `config.apiKey`).
   */
  async embed(text: string): Promise<number[]> {
    this._assertApiKey('embed')
    const url = `${this.baseUrl}/v1/embeddings`
    const body = { model: this.embeddingModel, input: text }
    const response = _embedFetchOverride
      ? await _embedFetchOverride(url, body, this.apiKey)
      : await this._httpPostEmbed(url, body)

    const embedding = response.data[0]?.embedding
    if (!embedding) {
      throw new Error(
        'OpenAiInferenceClient.embed(): unexpected response shape — ' +
          'no embedding in response.data[0].',
      )
    }
    return embedding
  }

  // -------------------------------------------------------------------------
  // InferenceClient.retrieve — requires database access
  // -------------------------------------------------------------------------

  /**
   * Retrieval requires database access and is implemented by the retrieval
   * layer (issues #10/#14). This hosted-provider adapter does not implement
   * retrieval.
   */
  retrieve(_query: string, _mode: RetrievalMode): Promise<RetrievalResult> {
    return Promise.reject(
      new Error(
        'OpenAiInferenceClient.retrieve(): retrieval requires database ' +
          'access and is not implemented by the hosted-provider adapter. ' +
          'The retrieval layer (issues #10/#14) owns this path.',
      ),
    )
  }

  // -------------------------------------------------------------------------
  // InferenceClient.score
  // -------------------------------------------------------------------------

  /**
   * Score each evidence block's relevance to `query` using the OpenAI Chat
   * Completions API.
   *
   * Sends a single prompt listing all blocks and asks the model to rate each
   * on a 0–10 scale. Scores are normalised to [0, 1]. Order of returned
   * scores matches the input order.
   *
   * Requires `OPENAI_API_KEY` (or `config.apiKey`).
   */
  async score(query: string, evidence: RetrievedBlock[]): Promise<EvidenceScore[]> {
    this._assertApiKey('score')
    if (evidence.length === 0) return []

    const blockList = evidence
      .map((b, i) => `Block ${i} (id=${b.blockId}): ${(b.text ?? '').slice(0, 300)}`)
      .join('\n')

    const userPrompt =
      `Rate how relevant each block is to the query on a scale of 0 to 10.\n` +
      `Query: ${query.slice(0, 500)}\n\n${blockList}\n\n` +
      `Reply with exactly one line per block in the format: ` +
      `"Block <index>: <score>" where <score> is an integer 0-10.`

    const responseText = await this._callChat(userPrompt)

    const scores: EvidenceScore[] = evidence.map((block, i) => {
      const match = responseText.match(new RegExp(`Block\\s+${i}\\s*:\\s*(\\d+)`))
      const raw = match ? parseInt(match[1], 10) : 5
      return { blockId: block.blockId, score: Math.min(10, Math.max(0, raw)) / 10 }
    })
    return scores
  }

  // -------------------------------------------------------------------------
  // InferenceClient.classifyLink
  // -------------------------------------------------------------------------

  /**
   * Classify the relation between two candidate blocks using the OpenAI Chat
   * Completions API.
   *
   * Returns one of the SIGNALS labels (`supports | contradicts | elaborates |
   * overrides | is-exception-to`) or `null` when no link should be produced.
   *
   * Fast-path: returns `null` immediately when `cosineSim < 0.70` (same
   * threshold as the heuristic linker in `src/linker/ai.ts`).
   *
   * Requires `OPENAI_API_KEY` (or `config.apiKey`).
   */
  async classifyLink(input: ClassifyLinkInput): Promise<string | null> {
    // Fast-path cosine bypass — mirrors the heuristic linker threshold.
    if (input.cosineSim < 0.70) return null

    this._assertApiKey('classifyLink')

    const labelList = LINK_LABELS.join(' | ')
    const userPrompt =
      `Classify the relationship between Block A and Block B.\n\n` +
      `Block A: ${input.contentA.slice(0, 400)}\n\n` +
      `Block B: ${input.contentB.slice(0, 400)}\n\n` +
      `Choose exactly one label from: ${labelList}\n` +
      `If no meaningful relationship exists, reply with: none\n` +
      `Reply with only the label, nothing else.`

    const responseText = await this._callChat(userPrompt)
    const trimmed = responseText.trim().toLowerCase()

    if ((LINK_LABELS as ReadonlyArray<string>).includes(trimmed)) {
      return trimmed as LinkLabel
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _assertApiKey(method: string): void {
    if (!this.apiKey) {
      throw new Error(
        `OpenAiInferenceClient.${method}(): OPENAI_API_KEY is not set. ` +
          `Set the env var or pass apiKey in the config to use the OpenAI adapter.`,
      )
    }
  }

  /**
   * Call the OpenAI Chat Completions API with a single user message. Returns
   * the text content of the first choice.
   */
  private async _callChat(userPrompt: string): Promise<string> {
    const url = `${this.baseUrl}/v1/chat/completions`
    const body = {
      model: this.chatModel,
      max_tokens: 256,
      messages: [{ role: 'user', content: userPrompt }],
    }

    const response = _chatFetchOverride
      ? await _chatFetchOverride(url, body, this.apiKey)
      : await this._httpPostChat(url, body)

    const text = response.choices[0]?.message?.content
    if (text === undefined || text === null) {
      throw new Error(
        'OpenAiInferenceClient: unexpected response shape — ' +
          'no content in choices[0].message.',
      )
    }
    return text
  }

  private async _httpPostChat(
    url: string,
    body: unknown,
  ): Promise<{ choices: Array<{ message: { content: string } }> }> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(
        `OpenAiInferenceClient: HTTP ${resp.status} from OpenAI API: ${text.slice(0, 200)}`,
      )
    }
    return (await resp.json()) as { choices: Array<{ message: { content: string } }> }
  }

  private async _httpPostEmbed(
    url: string,
    body: unknown,
  ): Promise<{ data: Array<{ embedding: number[] }> }> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(
        `OpenAiInferenceClient: HTTP ${resp.status} from OpenAI API (embeddings): ${text.slice(0, 200)}`,
      )
    }
    return (await resp.json()) as { data: Array<{ embedding: number[] }> }
  }
}
