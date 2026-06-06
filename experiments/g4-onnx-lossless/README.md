# G4 — ONNX Losslessness Spike

**Gate:** G4  
**Hypothesis:** H7.3 (Area 7 — Differentiable Graph Model and Lossless Frozen Export)  
**Phase:** 1A (runs if G0 passes)  
**Research doc:** `docs/research.md`, Area 7, H7.3

---

## Purpose

This spike tests whether the trained `TypedLinkGraphModel` (built in G0) can be
serialized to ONNX without approximation loss — i.e., whether the frozen ONNX
artifact and the live PyTorch model produce equivalent outputs on a held-out eval set.

**Pass criterion:** ONNX Runtime outputs match PyTorch outputs within 1% accuracy
delta on the held-out contradiction-detection pairs.

---

## NOT Distillation

This is not distillation. Loss from distillation comes from parameter reduction —
compressing a large teacher into a smaller student. That is not what happens here.

The exported ONNX model contains:
- The same block embedding parameters as the live graph
- The same link weight tensors
- The same typed message-passing computation graph

The only structural change is that the discrete graph topology (which nodes connect
to which) is encoded as sparse adjacency tensors fixed at export time. This is
serialization, not compression.

---

## Run

```bash
cd experiments/g4-onnx-lossless
pip install -e .
pip install -e ../g0-differentiability

python run_spike.py \
    --n-training-steps 500 \
    --seed 42 \
    --output results/g4_result.json
```

Exit code: `0` if G4 passes (accuracy delta < 1%), `1` if it fails.

---

## Tests

```bash
pytest tests/test_g4.py -v
```

All tests run on CPU. No GPU required.

---

## Export Strategy

`export.py` tries two strategies:

1. **Full `torch.onnx.export`** — wraps the model with a `_TracableWrapper` that
   embeds the fixed graph topology (edge_index, edge_type) as constants, exposing
   only `x` and `edge_confidence` as dynamic inputs. This avoids PyG's dynamic
   scatter tracing issues.

2. **NumPy weight fallback** — if `torch.onnx.export` fails (PyG models often have
   tracing issues), exports all model parameters to a `.npz` archive plus a
   hand-constructed ONNX model using only ONNX-native ops (MatMul, Gather, Sigmoid,
   Concat). The fallback is mathematically identical to the PyTorch forward pass.

Both paths preserve all parameters exactly.

---

## Files

| File | Purpose |
|---|---|
| `export.py` | ONNX export of TypedLinkGraphModel |
| `inference.py` | ONNX Runtime + NumPy fallback inference |
| `eval_losslessness.py` | Round-trip accuracy comparison |
| `run_spike.py` | Main entry point (CLI) |
| `tests/test_g4.py` | Unit tests (CPU, no GPU) |
| `results/` | JSON results from spike runs |

---

## Decision

| Outcome | Consequence |
|---|---|
| G4 PASS (delta < 1%) | Lossless frozen export is valid. ONNX product tier stands. |
| G4 FAIL (delta >= 1%) | Frozen export requires distillation framing. The "lossless serialization" product tier claim is withdrawn. Area 7 continues with a distillation-based frozen artifact. |
