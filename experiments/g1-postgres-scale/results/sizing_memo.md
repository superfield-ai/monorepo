# H1.3 Sizing Memo — Embedding Storage Dominance

At 1536 embedding dimensions (text-embedding-3-small default):

| n_blocks | Embedding (float32) | Embedding (int8) | Est. total DB | Embedding fraction |
|---|---|---|---|---|
| 1M  | 6.1 GB  | 1.5 GB  | ~8.2 GB   | ~75% |
| 5M  | 30.7 GB | 7.7 GB  | ~41.2 GB  | ~75% |
| 20M | 122.9 GB| 30.7 GB | ~164.7 GB | ~75% |
| 100M| 614.4 GB| 153.6 GB| ~823.3 GB | ~75% |

Conclusion: embedding storage dominates at > 70% of total DB size across all scales.
This motivates quantization (int8 reduces embedding cost by 4x) and motivates
the GPU paging strategy in Area 6 (H6.5, H6.6).

---

## Derivation

Storage components per block (empirical estimates from schema analysis):

| Component | Size/block | Notes |
|---|---|---|
| Embedding (float32, 1536 dims) | 6,144 bytes | 1536 × 4 bytes |
| Block content + metadata (avg) | ~400 bytes | 200 bytes content + JSONB + UUID/int cols |
| HNSW index overhead | ~500 bytes | pgvector builds HNSW on top of IVFFLAT pages |
| Links (~10 per block, avg) | ~800 bytes | 10 × ~80 bytes each (UUID pair + JSONB provenance) |
| **Non-embedding total** | **~1,700 bytes** | |
| **Total per block** | **~7,844 bytes** | |
| **Embedding fraction** | **~74.5%** | 6,144 / 7,844 |

Estimated ratio: total DB ≈ 1.34 × embedding storage → embedding fraction ≈ 1/1.34 ≈ 75%.

### H1.3 Resolution

H1.3 is resolved as arithmetic (not an experiment). At 1536 dimensions, embedding
storage consistently exceeds 70% of total DB size across all target scales (1M–100M
blocks). This is robust to ±30% variation in link density or content length:

- Even if non-embedding components double (2× links, longer content), the fraction
  stays above 60%.
- Quantizing to int8 (1 byte/dim) reduces the embedding column by 4×, bringing the
  fraction below 50% and making non-embedding costs dominant — which changes the
  optimization target.

**Implication for Area 6:** The GPU paging strategy (H6.5, H6.6) must primarily
address the embedding matrix. At 5M blocks, float32 embeddings occupy ~30.7 GB —
comfortably within a single A100 80 GB GPU. At 20M blocks (~122.9 GB float32 or
~30.7 GB int8), tiered VRAM management becomes necessary.
