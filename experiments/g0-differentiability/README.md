# G0 Differentiability Spike

**Gate G0 — H7.1 kill criterion (Phase 0)**

This experiment answers the most load-bearing question in the Nexum research program:

> Can the typed-link block graph be formulated as a differentiable model whose forward pass admits backpropagation?

**Pass criterion:** Loss decreases monotonically within 1,000 gradient steps on a synthetic 10K-block corpus.

**Exit 0 → Phase 1A** (differentiable program — train the graph end-to-end)
**Exit 1 → Phase 1B** (retrieval-only program — Area 2 curriculum → student model)

See `docs/research.md` (Area 7, Phase 0 Spike A) and `docs/research/methodology.md` for the full context.

---

## Setup

```bash
cd experiments/g0-differentiability
pip install -e .
```

For GPU support, install the CUDA-enabled PyTorch variant first (see https://pytorch.org/get-started/locally/), then install torch-geometric.

---

## Run the spike

```bash
python run_spike.py
```

Optional flags:

```
--n-steps 1000          # gradient steps (default: 1000)
--seed 42               # random seed (default: 42)
--output results/g0_result.json   # output path (default: results/g0_result.json)
--no-plot               # skip loss curve PNG
--lr 1e-3               # learning rate (default: 1e-3)
--n-nodes 10000         # synthetic graph nodes (default: 10000)
--n-edges 50000         # synthetic graph edges (default: 50000)
```

---

## Run tests

```bash
pytest tests/ -v
```

All tests run on CPU without GPU. Expected runtime on a modern laptop: under 60 seconds.

---

## Output

After a successful run, `results/` contains:

```
results/
├── g0_result.json      ← machine-readable result
└── g0_loss_curve.png   ← loss curve plot (full + smoothed)
```

`g0_result.json` schema:

```json
{
  "pass": true,
  "loss_curve": [...],
  "monotone_decrease": true,
  "gradient_health": "ok",
  "n_steps": 1000,
  "final_loss": 0.1234,
  "initial_loss": 0.6931,
  "hardware": {"device": "cuda", "torch_version": "2.3.0", ...},
  "seed": 42,
  "gradient_norms": [...]
}
```

---

## Pass criterion (H7.1)

From `docs/research.md`:

> **H7.1 [CORE]:** The typed-link-weighted message-passing forward pass over the Nexum block graph is differentiable via soft attention relaxation of discrete traversal, and gradient descent over block embeddings and link weights **converges in fewer than 10K gradient steps** on domain-specific tasks.
>
> **Kill criterion:** if loss does not decrease monotonically within **1K steps** on a 10K-block synthetic corpus, the differentiability claim fails and the area reverts to distillation (Area 2 curriculum → student model).

**How monotone decrease is evaluated.** The gate uses a 50-step rolling-mean
view of the loss curve and requires it to decrease monotonically (with a
1e-3 tolerance per smoothed step). The strict per-step check
(`MONOTONE_TOL = 0.01`) is also recorded as a diagnostic — Adam-style
optimizers routinely violate strict step-wise monotonicity even on
successfully converging runs.

## Latest result (10K nodes, 1K steps, seed 42)

| Metric | Value |
| --- | --- |
| Pass | **true** |
| Initial loss (BCE) | 0.6938 |
| Final loss (BCE) | 0.0036 |
| Loss reduction | 99.5% |
| Monotone (smoothed, w=50) | true |
| Monotone (strict, tol=0.01) | false (Adam oscillation, max bump 0.033) |
| Gradient health | ok |
| Wall time | 83.9s on CPU (83.9 ms/step) |

Canonical envelope: `results/g0_20260509T012411Z.json` (schema v1, written via
`experiments/_lib/results_writer`).

The H7.1 kill criterion is **not** triggered — Area 7 proceeds on the
differentiable-program path.

---

## Architecture

### `model.py` — `TypedLinkGraphModel`

- Base: `torch_geometric.nn.MessagePassing` with sum aggregation
- Edge types: 5 (`cites`, `contradicts`, `supports`, `elaborates`, `is-exception-to`)
- Each edge type has a learned 16-dim type embedding
- Attention weight: `sigmoid(confidence × w_attn(type_emb))` — differentiable gate
- 2-layer message-passing stack with LayerNorm and dropout
- Classification head: MLP over concatenated pair embeddings → single logit

### `data.py` — Synthetic corpus generator

- 10K nodes, 128-dim clustered embeddings (L2-normalized)
- ~50K edges across 5 types; `contradicts` edges are cross-cluster, `supports` are within-cluster
- 1K labeled pairs (balanced positive/negative) for binary contradiction detection
- Fully deterministic given a seed

### `train.py` — Training loop

- `BCEWithLogitsLoss` on the contradiction detection task
- Full-graph training (single-batch, no mini-batching for the spike)
- Monotone decrease checker with configurable tolerance
- Gradient health classification: "ok" | "vanishing" | "exploding"

---

## Interpretation

| Result | Meaning | Next step |
|--------|---------|-----------|
| EXIT 0 (`pass: true`) | H7.1 confirmed — graph is differentiable | Phase 1A: ONNX losslessness spike (G4), wedge demo (G2) |
| EXIT 1 (`pass: false`, `gradient_health: vanishing`) | Gradient vanishes through the typed-link layers | Investigate: reduce depth, change aggregation, try mean pooling |
| EXIT 1 (`pass: false`, `gradient_health: exploding`) | Gradients explode | Add gradient clipping (`torch.nn.utils.clip_grad_norm_`) and retry |
| EXIT 1 (`pass: false`, `monotone_decrease: false`) | Loss oscillates or diverges | Reduce lr, increase batch diversity, check edge confidence scale |
| EXIT 1 (all paths fail) | H7.1 falsified | Phase 1B: Area 2 becomes primary training direction |
