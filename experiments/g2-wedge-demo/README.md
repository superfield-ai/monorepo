# G2 Wedge Demo — Nexum Provenance vs. Vanilla RAG

**Gate G2** is the program's product-market fit gate. This experiment combines:

- **H4.4** — block-level provenance: every answer traces to specific source blocks, with attribution F1 measured against gold spans. Target: < 5% false attribution rate for Nexum.
- **H5.1 / H5.2** — real-time ingest capability: the corpus is ingested into Nexum and queried immediately.
- **Typed-link retrieval vs. vanilla RAG** — same corpus, same LLM (Claude Haiku), only the retrieval mechanism differs.

If this demo shows Nexum attribution F1 > vanilla LlamaIndex RAG by > 5 percentage points on a held-out CUAD question set, the program continues into full Phase 1 research. If not, the program narrows to pure systems research (Areas 1, 5, 6 only).

---

## What it tests and why it matters

LlamaIndex citation RAG returns chunks of text that are semantically similar to the question. It has no structured notion of *which document* a chunk came from, and no typed-link graph to constrain attribution.

Nexum's typed-link retrieval traces each answer to a specific block in the graph, preserving the chain:

```
answer → block_id → document_id → source contract
```

The H4.4 hypothesis is that this structural provenance produces a lower false attribution rate than the flat-chunk citation list returned by vanilla RAG. That gap — if it exists — is the product wedge for legal/medical buyers who require auditability.

---

## Directory layout

```
experiments/g2-wedge-demo/
├── corpus.py           # Load CUAD contracts and QA pairs (with synthetic fallback)
├── nexum_rag.py        # Nexum typed-link RAG client
├── vanilla_rag.py      # LlamaIndex baseline RAG
├── attribution_eval.py # Attribution precision / recall / F1 measurement
├── run_demo.py         # Main comparison runner (CLI)
├── pyproject.toml
├── results/            # Output JSON (git-ignored)
└── tests/
    └── test_g2.py      # 9 tests, no live services required
```

---

## Setup

```bash
cd experiments/g2-wedge-demo
pip install -e ".[dev]"

# Optional: llama-index extras for VanillaRAG
pip install llama-index llama-index-llms-anthropic
```

The CUAD corpus is loaded from the lab-bench fixture. If it has not been
downloaded yet, a small synthetic corpus is used automatically (suitable for
dry-runs and CI):

```bash
# Download CUAD (~650 MB) — optional
cd experiments/lab-bench
python fixtures/cuad.py --output-dir data/cuad
```

---

## Run

```bash
python run_demo.py \
  --nexum-url http://localhost:3000 \
  --anthropic-key $ANTHROPIC_API_KEY \
  --max-contracts 50 \
  --max-questions 50 \
  --output results/g2_result.json
```

**Dry-run** (no LLM calls, no Nexum — useful for CI):

```bash
python run_demo.py --dry-run
```

---

## Interpreting results

The runner prints a summary and writes `results/g2_result.json`:

```json
{
  "nexum":      {"attribution_f1": 0.82, "false_attribution_rate": 0.18, "mean_answer_length": 320},
  "vanilla_rag":{"attribution_f1": 0.61, "false_attribution_rate": 0.39, "mean_answer_length": 410},
  "delta_attribution_f1": 0.21,
  "g2_signal": "pass",
  "n_questions": 50,
  "per_question": [...]
}
```

| Signal | Meaning |
|---|---|
| **G2 PASS** | Nexum attribution F1 > Vanilla RAG by > 5pp. Program continues into full Phase 1. |
| **G2 INCONCLUSIVE** | Delta is within ±5pp. No clear winner; provenance claim needs more data. |
| **G2 FAIL** | Vanilla RAG attribution F1 exceeds Nexum by > 5pp. Program narrows to systems research (Areas 1, 5, 6 only). |

The **false attribution rate** is `1 − precision`. Nexum's H4.4 target is < 5% (precision > 0.95) on block-level provenance. Vanilla RAG's rate is expected to be higher because it has no structured provenance chain.

---

## Tests

```bash
python3 -m pytest tests/test_g2.py -v
```

All 9 tests run without any live services. They cover:

1. Perfect attribution F1 (precision = recall = F1 = 1)
2. Complete miss (all zeros)
3. Partial match (2 of 5 correct → precision = 0.4)
4. False attribution rate = 1 − precision identity
5. NexumRAG graceful ConnectionError handling
6. VanillaRAG ingest with mocked LlamaIndex
7. Corpus loading from a temp JSONL file
8. Corpus max-contracts cap
9. Dry-run produces correct output structure

---

## Related documents

- `docs/research.md` — Area 4 (H4.4), Area 5 (H5.1/H5.2), Gate G2 decision criteria
- `docs/research/methodology.md` — LlamaIndex citation mode as the required baseline
- `docs/lab-bench.md` — CUAD fixture, attribution F1 metrics
