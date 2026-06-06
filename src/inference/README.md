# Inference module

The inference module provides a pluggable `InferenceClient` interface backed by
multiple adapters. The **default** adapter runs fully in-process on CPU with no
API keys required.

## Backend selection

Set `NEXUM_INFERENCE_BACKEND` to choose an adapter. If the variable is unset or
set to an unknown value, the module falls back to `local-cpu` and logs once to
stderr.

| `NEXUM_INFERENCE_BACKEND` | Adapter | Requires |
|--------------------------|---------|----------|
| _(unset)_ / `local-cpu` | `LocalCpuInferenceClient` | ONNX weights (run `npm run fetch-model`) |
| `stub`                   | `StubInferenceClient` | nothing — every method throws |
| `anthropic`              | `AnthropicInferenceClient` | `ANTHROPIC_API_KEY` |
| `openai`                 | `OpenAiInferenceClient` | `OPENAI_API_KEY` |

## Opt-in: Anthropic adapter

```bash
NEXUM_INFERENCE_BACKEND=anthropic \
ANTHROPIC_API_KEY=sk-ant-… \
node dist/index.js
```

- **classifyLink** and **score** route through the Anthropic Messages API
  (`claude-3-haiku-20240307` by default).
- **embed** is **not supported** — Anthropic does not provide a first-party
  embedding endpoint. Use `local-cpu` or `openai` for embeddings.
- **retrieve** is not implemented — the retrieval layer (issues #10/#14) owns
  database access regardless of adapter.

Override the model or API base URL via the constructor config (useful for tests
pointing at a stub server):

```ts
import { AnthropicInferenceClient } from './adapters/anthropic.js'
const client = new AnthropicInferenceClient({
  apiKey: 'sk-ant-…',
  model: 'claude-3-5-sonnet-20241022',
})
```

## Opt-in: OpenAI adapter

```bash
NEXUM_INFERENCE_BACKEND=openai \
OPENAI_API_KEY=sk-… \
node dist/index.js
```

- **embed** calls the OpenAI Embeddings API (`text-embedding-3-small` by
  default, 1536-dimensional).
- **classifyLink** and **score** route through Chat Completions (`gpt-4o-mini`
  by default).
- **retrieve** is not implemented — see above.

Override models or API base URL:

```ts
import { OpenAiInferenceClient } from './adapters/openai.js'
const client = new OpenAiInferenceClient({
  apiKey: 'sk-…',
  embeddingModel: 'text-embedding-3-large',
  chatModel: 'gpt-4o',
})
```

## Default: local-CPU adapter

Runs `@xenova/transformers` ONNX models fully in-process — no API key, no
network calls after the initial weight download.

```bash
npm run fetch-model        # one-time: download & cache ONNX weights
node dist/index.js         # NEXUM_INFERENCE_BACKEND defaults to local-cpu
```

See `local-cpu.ts` for the model selection rationale and concurrency notes.

## Using the client in application code

```ts
import { getDefaultInferenceClient } from './inference/index.js'

const client = getDefaultInferenceClient()   // memoised, adapter chosen by env
const label = await client.classifyLink({
  contentA: 'Study A shows X.',
  contentB: 'Study B replicates X.',
  cosineSim: 0.82,
})
```

Call sites never import a concrete adapter directly — only
`getDefaultInferenceClient()` (or `setDefaultInferenceClient()` in tests).

## Testing without API keys

Each hosted adapter exports a fetch-override seam:

```ts
import {
  injectAnthropicFetchForTest,
  resetAnthropicFetchForTest,
} from '../../dist/inference/adapters/anthropic.js'

injectAnthropicFetchForTest(async (_url, _body, _key) => ({
  content: [{ type: 'text', text: 'supports' }],
}))
// … run test …
resetAnthropicFetchForTest()
```

Similarly for OpenAI:

```ts
import {
  injectOpenAiChatFetchForTest,
  resetOpenAiChatFetchForTest,
  injectOpenAiEmbedFetchForTest,
  resetOpenAiEmbedFetchForTest,
} from '../../dist/inference/adapters/openai.js'
```

Canonical references: `docs/architecture.md` § A3 / A4 / OD4,
`docs/implementation-plan.md` Phase 3 issues #108 / #105 / #114.
