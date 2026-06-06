# Phase 6 Harness Audit — Evidence-Based Expansion Seams

Scout issue: #144
Date: 2026-05-14
Canonical refs: `experiments/`, `docs/research/hypotheses/`

---

## 1. results_writer Interface — Stable vs. Experimental Fields

Module: `experiments/_lib/results_writer.py`

### ResultEnvelope constructor fields

| Field        | Type                        | Required | Notes                                    |
|--------------|-----------------------------|----------|------------------------------------------|
| `gate`       | `str`                       | yes      | Short gate/hypothesis ID, e.g. `"H1.2"` |
| `hypothesis` | `str`                       | yes      | Same as gate for hypothesis experiments  |
| `passed`     | `bool`                      | yes      | Gate-level pass/fail                     |
| `metrics`    | `dict[str, Any]`            | yes      | Gate-specific metric dict                |
| `runtime`    | `RunContext`                | yes      | From `capture_run_context()`             |
| `notes`      | `str \| None`               | no       | Free-text observation                    |
| `extra`      | `dict[str, Any]`            | no       | Overflow fields, must not duplicate above|

### Serialized JSON envelope (top-level keys, `schema_version=1`)

| Key              | Type    | Status    | Notes                                               |
|------------------|---------|-----------|-----------------------------------------------------|
| `schema_version` | int     | **stable** | Always `1`                                         |
| `gate`           | str     | **stable** |                                                     |
| `hypothesis`     | str     | **stable** |                                                     |
| `pass`           | bool    | **stable** | Note: serialized as `pass`, field stored as `passed`|
| `metrics`        | dict    | **stable** | Shape is gate-specific                              |
| `runtime`        | dict    | **stable** | `RunContext.to_dict()` — see runner.py              |
| `results_path`   | str     | **stable** | Absolute path set by `write_result()`               |
| `notes`          | str     | optional  | Present only when non-empty                         |
| `extra`          | dict    | optional  | Present only when non-empty                         |

### write_result() signature

```python
write_result(
    envelope: ResultEnvelope,
    area_dir: str | os.PathLike[str],
    *,
    timestamp: float | None = None,   # test hook: fixed epoch for filename slug
    filename: str | None = None,      # test hook: explicit filename
) -> Path
```

Output file lands at: `<area_dir>/results/<gate_lowercased>_<YYYYMMDDTHHMMSSZ>.json`

### Importable via

```python
from experiments._lib import ResultEnvelope, capture_run_context, write_result
from experiments._lib.results_writer import SCHEMA_VERSION  # == 1
```

**Importability verified:** `python3 -c "from experiments._lib.results_writer import ResultEnvelope, write_result, SCHEMA_VERSION; print('OK')"` — passes in this checkout.

---

## 2. Hypothesis File Audit

All five phase-6 hypotheses confirmed present with frontmatter:

| Hypothesis | File                                                          | Status               | results_path present?     |
|------------|---------------------------------------------------------------|----------------------|---------------------------|
| H1.2       | `docs/research/hypotheses/H1.2_graph-beats-semantic-cross-type.md`  | `failed`      | yes — `experiments/area1-storage-fitness/results/h1.2_20260510T015402Z.json` |
| H5.1       | `docs/research/hypotheses/H5.1_hnsw-update-dominates-latency.md`    | `provisional-supported` | no (missing) |
| H5.4       | `docs/research/hypotheses/H5.4_embedding-drift-below-threshold.md`  | `provisional-supported` | no (missing) |
| H4.1       | `docs/research/hypotheses/H4.1_block-level-auditability.md`         | `untested`    | yes — `null` |
| H2.1       | `docs/research/hypotheses/H2.1_contrastive-links-better-finetuning.md` | `untested` | no (missing) |

All five frontmatter blocks are valid YAML with the required keys: `id`, `status`, `area`, `confidence_prior`.

**Gap noted for H5.1 and H5.4:** `results_path` is absent from frontmatter even though provisional results exist from prior experiment runs in `experiments/area5-update-semantics/results/` (the `run_area5.py` orchestrator writes to `results/area5_results.json` — a combined bundle, not the canonical per-gate envelope format). The individual issue authors for #139 (H5.1) and #140 (H5.4) should use `write_result()` + `ResultEnvelope` to produce a canonical per-gate JSON and backfill `results_path` in the hypothesis frontmatter.

---

## 3. Output Path Analysis — Overlap Check

### Experiments that use the canonical write_result() pattern

| Hypothesis | Script                                                          | area_dir argument         | Output path pattern                                          |
|------------|-----------------------------------------------------------------|---------------------------|--------------------------------------------------------------|
| H1.2       | `experiments/area1-storage-fitness/h12_retrieval_comparison.py` | `Path(__file__).parent`   | `experiments/area1-storage-fitness/results/h1.2_<ts>.json`  |
| H2.1       | `experiments/area2-training-curriculum/run_h2_1_headtohead.py` | `Path(__file__).parent`   | `experiments/area2-training-curriculum/results/h2.1_<ts>.json` |
| H4.2       | `experiments/area4-provenance/run_h4_2_multihop.py`            | `args.output_dir`         | user-specified or default `experiments/area4-provenance/results/h4.2_<ts>.json` |

### Experiments that use a bespoke JSON dump (not ResultEnvelope)

| Hypothesis | Script                                                     | Output path                                      | Notes                                        |
|------------|------------------------------------------------------------|--------------------------------------------------|----------------------------------------------|
| H5.1       | `experiments/area5-update-semantics/run_area5.py`          | `results/area5_results.json` (relative to cwd)   | Combined bundle for all H5.x; no RunContext  |
| H5.4       | same as H5.1                                               | same as H5.1                                     | Embedded as `h5_4` key inside bundle         |
| H4.1       | `experiments/area4-provenance/run_area4.py`                | `results/area4_results.json` (relative to cwd)   | Combined bundle for all H4.x; no RunContext  |

**No overlapping file paths detected.** Each area writes to its own `results/` subdirectory, and the timestamped filenames prevent concurrent write conflicts for canonical-format experiments. The bundle-format experiments (area5, area4) produce a single fixed-name file per run (`area5_results.json`, `area4_results.json`) — concurrent runs to the same working directory would overwrite; this is acceptable because these scripts are run sequentially from their experiment directory.

### Concurrent-safety verdict

- Canonical `write_result()` experiments (H1.2, H2.1, H4.2): safe for concurrent runs — each write is an independent timestamped file.
- Bundle experiments (H5.1, H5.4, H4.1): safe if run from different working directories; otherwise last-writer-wins on the fixed output filename. Recommended fix: pass `--output` with a run-specific path when running concurrently.

---

## 4. Harness Caveats for Phase 6 Issue Authors

### Caveat A — H5.1 (#139) and H5.4 (#140): adopt ResultEnvelope

The `run_area5.py` orchestrator currently writes a bespoke combined JSON bundle instead of calling `write_result()`. Phase 6 issue authors must:

1. Import `ResultEnvelope`, `write_result`, `capture_run_context` from `experiments._lib`.
2. Construct a per-gate envelope (one per hypothesis) at the end of the experiment run.
3. Call `write_result(envelope, "experiments/area5-update-semantics")` to emit the canonical file.
4. Update the hypothesis frontmatter `results_path` field to point to the emitted file.

### Caveat B — H4.1 (#141): adopt ResultEnvelope

`run_area4.py` similarly uses a bespoke bundle. H4.1 issue author should emit a per-gate `ResultEnvelope` for gate `"H4.1"` and update the frontmatter `results_path` (currently `null`).

### Caveat C — results_path field in H5.1 / H5.4 frontmatter is absent

The frontmatter for H5.1 and H5.4 does not have a `results_path` key at all (H4.1 has it but as `null`). Before closing the phase-6 issues, the frontmatter should be updated to include `results_path: <canonical path>`.

### Caveat D — H1.2 results_path is an absolute worktree path

The existing `h1.2_20260510T015402Z.json` result has `results_path` set to an absolute worktree path (`/home/lucas/tmp/agent-worktrees/...`). When running fresh experiments, `write_result()` uses `out.as_posix()` which will again be absolute. For reproducibility, the hypothesis frontmatter and any meta-analysis scripts should treat `results_path` as informational only and locate result files by scanning `experiments/<area>/results/` rather than trusting the stored path.

---

## 5. Importability Smoke Test

```
$ python3 -m pytest experiments/_lib/tests/test_harness.py -v
5 passed in 2.68s
```

All harness smoke tests pass in this checkout (2026-05-14). The `results_writer` module is importable and emits the canonical envelope shape.
