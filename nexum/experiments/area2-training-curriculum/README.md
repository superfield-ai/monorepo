# Area 2 — Graph as Training Curriculum

**Hypotheses:** H2.1 – H2.4  
**Research phase:** Phase 3 (Weeks 12–20)

---

## Purpose

Area 2 characterises the typed-link graph as a **training curriculum signal** for a language model. The central question: does constructing training data from typed block links (contrastive pairs from `contradicts` / `supports` edges) outperform random corpus sampling?

---

## G0-YES vs G0-NO roles

| Branch | Role of Area 2 |
|--------|----------------|
| **G0-YES** (graph is differentiable) | Secondary / characterisation. The graph is already gradient-trained; Area 2 experiments measure the *additional* signal that typed-link curriculum provides on top of the gradient pass. |
| **G0-NO** (retrieval-only path) | Primary training mechanism. Curriculum construction from typed links is the only way to train a model on graph structure. H2.1 becomes the gating experiment that replaces G0. |

Either way the experiments are identical: the code here runs in both branches.

---

## Hypotheses

### H2.1 — Contrastive pairs from typed links beat random sampling

Contrastive pairs drawn from `contradicts` (negative) and `supports` (positive) links produce better domain classification fine-tunes than randomly sampled pairs from the same corpus.

**Required baseline:** flat-random curriculum over the same corpus.

### H2.2 — BFS walk from high-centrality seeds beats random walk

A BFS walk seeded from high in-degree blocks (most incoming links) produces more coherent training sequences than random walk, as measured by next-token perplexity on held-out domain text.

### H2.3 — Link layer signal comparison (structural vs semantic vs AI)

The `ai` link layer (LLM-classified) produces higher-quality training signal than the `structural` layer for tasks requiring reasoning, while `structural` is superior for factual retrieval. Evaluated on MultiHop-RAG (reasoning) and CUAD clause extraction (retrieval).

### H2.4 — Graph-derived sequences generalise across document versions

Training on graph-derived sequences generalises better across document versions (version-delta test sets) than flat-corpus training.

---

## Module overview

| File | Purpose |
|------|---------|
| `curriculum_builder.py` | Pure-function builders for each curriculum type |
| `lm_finetuner.py` | `CurriculumFinetuner` — sentence-transformer fine-tuning (contrastive + classification) |
| `link_density_ablation.py` | H2.1 variant: sweep confidence threshold, measure downstream accuracy |
| `link_type_ablation.py` | H2.3: separate models for structural / semantic / AI link layers |
| `run_area2.py` | Orchestrator CLI for the four-hypothesis fan-out (uses mock accuracy) |
| `h2_1_curriculum_trainer.py` | **Honest H2.1 head-to-head**: three orderings × tiny linear classifier |
| `run_h2_1_headtohead.py` | Runs the head-to-head and emits a canonical result envelope |
| `tests/test_area2.py` | 11 unit tests (10 fast, 1 slow / skipped by default) |
| `tests/test_h2_1_trainer.py` | 3 fast smoke tests for the head-to-head trainer |

---

## Running

### Fast run (no fine-tuning, no network, no GPU)

```bash
cd experiments/area2-training-curriculum
python3 run_area2.py \
  --n-blocks 10000 \
  --n-pairs 1000 \
  --skip-finetuning \
  --output results/area2_results.json
```

### Full run (requires sentence-transformers)

```bash
python3 run_area2.py \
  --n-blocks 10000 \
  --n-pairs 1000 \
  --output results/area2_results.json
```

### Tests

```bash
# Fast tests (10 tests, CPU, no network)
python3 -m pytest tests/ -v -m "not slow"

# All tests including slow finetuner smoke-test
python3 -m pytest tests/ -v -m slow
```

---

## Curriculum types

### Flat random (`build_flat_random_curriculum`)

Randomly sample block pairs. Label = 1 if same domain, 0 otherwise. Baseline curriculum with no graph structure.

### BFS walk (`build_bfs_walk_curriculum`)

BFS traversal seeded from high-centrality blocks (highest in-degree). Returns sequences of block IDs suitable for next-block prediction training.

### Contrastive / triplet (`build_contrastive_curriculum`)

Uses typed links directly:
- **Positive pairs** — blocks connected by high-confidence `supports` links.
- **Negatives** — blocks connected by `contradicts` links (hard negative) or random (soft negative).

Returns `(anchor, positive, negative)` triplets for `TripletLoss` training.

### Version delta (`build_version_delta_curriculum`)

Pairs same-UUID blocks whose text changed between v1 and v2 (positive) against unchanged blocks (negative). Used to test cross-version generalisation.

---

## Link layer taxonomy

| Layer | `rel_type` values | Assigned by |
|-------|-------------------|-------------|
| `structural` | cites, elaborates, is-exception-to | Document parser |
| `semantic` | supports, contradicts | Rule-based / human |
| `ai` | anything else | LLM classifier with confidence score |

---

## H2.1 result (initial run)

Run: `python h2_1_curriculum_trainer.py` via `run_h2_1_headtohead.py`,
800 synthetic blocks × 5 seeds × 6 epochs, linear hashed-bag-of-tokens
classifier on a domain-classification task. Three orderings of the **same**
training examples:

| Ordering | mean eval acc | stdev | epochs to 0.80 |
|----------|---------------|-------|-----------------|
| BFS over `supports` (naive, by in-degree) | 0.448 | 0.081 | never reached |
| BFS, round-robin interleaved per domain | 0.974 | 0.023 | 3.8 |
| Random shuffle (baseline) | 0.978 | 0.022 | 3.6 |

**Verdict for H2.1: tie / not supported at this scale.** The graph-aware
interleaved curriculum matches random ordering within stdev; the naive BFS
curriculum collapses (catastrophic interference from long same-domain runs).
This is an honest negative result for the *ordering-only* form of H2.1 on a
synthetic corpus with a linear model. The richer contrastive triplet form
(`build_contrastive_curriculum` + `lm_finetuner.train_contrastive`) is left
as the natural follow-up — that variant is non-trivially different because it
changes the training *examples*, not just their order.

Result envelope: `results/h2.1_*.json` (canonical phase-0 envelope shape).
