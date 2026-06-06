# Local CPU model lockfile

Pinned local CPU model identity for the default `LocalCpuInferenceClient`
(issue #105). The actual weight files are not committed; `models/cache/`
is gitignored. The pinned identities and SHA-256 checksums live in
`models/manifest.json` (committed) and are mirrored here for human
review at PR-time.

## Pinned default

| field            | value                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| Hugging Face ID  | `Xenova/nli-deberta-v3-xsmall`                                              |
| Revision (SHA-1) | `2a4f614a701367a02d51389039afc998faeda637`                                  |
| Pipeline task    | `zero-shot-classification`                                                  |
| Format           | ONNX int8 quantized (`onnx/model_quantized.onnx`)                           |
| Total bytes      | ~99.4 MB                                                                    |
| Cache path       | `${NEXUM_MODEL_CACHE_DIR:-models/cache}/Xenova/nli-deberta-v3-xsmall/...`   |
| Source URL       | <https://huggingface.co/Xenova/nli-deberta-v3-xsmall/tree/main>             |

### Per-file SHA-256

| file                       | bytes      | sha256                                                             |
| -------------------------- | ---------: | ------------------------------------------------------------------ |
| `config.json`              |      1 038 | `ec0bd14cc28640326474399cd61d38ccd52b64900228799d0f81debda8c4bc53` |
| `tokenizer.json`           |  8 656 551 | `a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df` |
| `tokenizer_config.json`    |        384 | `d8d3bb123b99317634d5ee3d1d2d8b2ddb01510a0654687fc2639a5347a7291f` |
| `special_tokens_map.json`  |        173 | `311de3f4eed9d76a43bf0d71f10e62e086ca65ccce9f15d5da0d2098bf519ecc` |
| `added_tokens.json`        |         23 | `dc046d04c9b0ada7ae6f1dc89c465801799acdf0c9a6aab8c15a1b2d5ca4e91f` |
| `spm.model`                |  2 464 616 | `c679fbf93643d19aab7ee10c0b99e460bdbc02fedf34b92b05af343b4af586fd` |
| `quantize_config.json`     |      1 193 | `97ed567b73503b8d9d373d5a4124243fe6c11aef0fac5f26c2cf9ab661a116cc` |
| `onnx/model_quantized.onnx`| 87 246 587 | `3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6` |

## Fetching the weights

```bash
npm run fetch-model
```

The script reads `models/manifest.json`, downloads each file into
`${NEXUM_MODEL_CACHE_DIR:-models/cache}/<huggingface_id>/`, and verifies
the SHA-256. A no-op on a warm cache. CI may `actions/cache` the cache
directory and re-run the command on every build to assert integrity.

## Why not Phi-3-mini Q4_0 GGUF?

The issue title pinned `Phi-3-mini Q4_0 GGUF` as the aspirational target
with a TinyLlama-class fallback. Two hard constraints forced the actual
selection:

1. CI cold-start + one `classifyLink` call must complete in under 2
   minutes on a single CI core (issue #105 acceptance criterion).
2. The runtime model toolchain is `@xenova/transformers` (already a
   project dependency for embeddings); switching to a llama.cpp/GGUF path
   would require a separate native-binary integration that is out of
   scope here.

| candidate                              | approx bytes | cold-start verdict                                  |
| -------------------------------------- | -----------: | --------------------------------------------------- |
| Phi-3-mini Q4_0 GGUF                   |       2.4 GB | exceeds 2-minute budget on download alone           |
| TinyLlama Q4_0 GGUF                    |       640 MB | over budget once native llama.cpp build is included |
| **Xenova/nli-deberta-v3-xsmall** (selected) |   ~99 MB | fits the budget; sub-second per pair on CPU         |

For link classification (5-class: `supports` / `contradicts` /
`elaborates` / `overrides` / `is-exception-to` / none) we do NOT need a
full instruction-tuned LLM. A small NLI-based zero-shot classifier
directly scores "does premise X entail label hypothesis Y?" which is
exactly the link-relation question.

The `LocalCpuInferenceClient` interface is unchanged; swapping to a
GGUF-backed instruct LLM later is a backend-only change. See the
`fallback_ladder` field in `models/manifest.json` for the full rejection
chain and the held-in-reserve fallbacks (`Xenova/distilbart-mnli-12-1`,
`Xenova/mobilebert-uncased-mnli`).
