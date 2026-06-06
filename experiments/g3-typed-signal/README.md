# G3 — Typed-Link Gradient Signal

**Gate G3 / H7.2 — Phase 1A, Weeks 6–10 (requires G0 pass)**

## Purpose

G3 asks whether `contradicts` and `supports` edge types develop **statistically distinct learned weight profiles** during gradient descent, or whether the optimizer collapses all edge types to a single representation.

If G3 passes, typed link types are a meaningful gradient training axis — the `contradicts`/`supports`/`cites`/`elaborates`/`is-exception-to` distinction carries independent signal that the GNN exploits. If G3 fails, the model is simplified to standard GNN aggregation over untyped edges and the link type layer is dropped from the gradient training path.

## What "Typed-Link Gradient Signal" Means

The `TypedLinkGraphModel` (from G0) assigns each edge type a learned embedding vector. During training, the attention weight for each edge is computed as:

```
attn_logit = edge_confidence × w_attn(type_embedding[edge_type])
```

If typed link structure carries gradient signal, edges of the same type should converge to similar attention profiles, while edges of different types should develop distinct profiles. Formally:

- **Within-type distances** (same edge type): should be small (similar attention behaviour)
- **Cross-type distances** (different edge types): should be larger (distinct behaviour)

G3 measures this using a **Mann-Whitney U test** on the within-type vs. cross-type distance distributions. Pass criterion: p < 0.05 (same-type distances are statistically significantly smaller than cross-type distances).

G3 also trains an `UntypedGNNModel` — the same architecture but with all edge types treated identically — and compares task accuracy to determine whether typed links improve performance.

## Run

```bash
# Quick test (10K nodes, 500 steps)
python3 run_spike.py --corpus-size 10000 --n-steps 500 --output results/g3_result.json

# Full run (100K nodes)
python3 run_spike.py --corpus-size 100000 --n-steps 500 --output results/g3_result.json

# Headless / CI (no matplotlib)
python3 run_spike.py --n-steps 100 --corpus-size 1000 --no-plot --output results/g3_result.json
```

Exit codes: **0** = G3 pass, **1** = G3 fail.

## Pass Criterion

> After training, the cosine distance between same-type edge weight vectors is **statistically significantly smaller** than the distance between cross-type edge weight vectors, with **p < 0.05** on a two-sample Mann-Whitney U test.

## Output

`results/g3_result.json` — full result record:

```json
{
  "pass_g3": true,
  "p_value": 0.003,
  "separation_ratio": 2.4,
  "typed_accuracy": 0.82,
  "untyped_accuracy": 0.71,
  "typed_better": true,
  "accuracy_delta": 0.11,
  "interpretation": "Typed links develop distinct gradient profiles..."
}
```

`results/g3_type_embeddings.png` — PCA plot of the 5 type embedding vectors after training. Visible clustering by type confirms the learned representations have separated.

## Tests

```bash
python3 -m pytest tests/ -v
```

31 tests covering:
1. `UntypedGNNModel` forward pass shape and correctness
2. `UntypedGNNModel` has no `type_embedding` parameter
3. `measure_edge_type_divergence` returns dicts with all 5 link types
4. Mann-Whitney U significance on injected separated/identical distributions
5. `separation_ratio` formula correctness with known vectors
6. `compare_typed_vs_untyped` returns all required keys
7. `pass_g3 = True` iff `mannwhitney_p_value < 0.05`
8. Type embedding vectors diverge from initialization after 100 training steps

## Scale Gap (Honest Report)

H7.2 targets a **100K-block** corpus. The shipped G3 spike result is at
**5K blocks / 500 Adam steps** (CPU, ~25s training time) — this is the
scale at which the spike completes within the per-issue time budget.

The 5K result is a **partial** confirmation: it demonstrates that the
TypedLinkGraphModel optimizer differentiates the 5 edge types
(p < 1e-6, separation_ratio ~5.1) at small scale. Whether the same
separation holds — or collapses — at 100K blocks must be re-confirmed
in Area 7 integration before treating H7.2 as fully established.

A larger 25K-block / 300-step run was previously executed (see
`results/g3_25k.log`) and also produced p < 1e-6, separation_ratio ~5.0,
which suggests the signal scales monotonically, but a true 100K run
remains future work attached to Area 7.

## Decision Outcome

| Result | Consequence |
|--------|-------------|
| G3 PASS (p < 0.05) | Typed link types retained as gradient training axis; proceed to full-corpus training (Area 7) |
| G3 FAIL (p ≥ 0.05) | Typed link types dropped from gradient axis; model reduces to standard GNN over untyped edges |

## Imports from G0

This experiment imports directly from `../g0-differentiability/`:
- `data.generate_synthetic_graph` — synthetic corpus generator
- `model.TypedLinkGraphModel` — typed-link GNN (G0 implementation)
- `model.EDGE_TYPES` — edge type name list

`G0 must pass before G3 is meaningful` — if the graph is not differentiable, there is no learned weight profile to measure.
