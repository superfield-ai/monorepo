"""
write_envelope.py — Wrap a `run_spike.py` legacy result JSON into the
canonical phase-0 result envelope used by `experiments/_lib/results_writer.py`.

The G3 spike (`run_spike.py`) writes a flat result dict. The orchestrator
and `scripts/update-hypothesis-status.sh` expect the canonical envelope
shape (gate / hypothesis / pass / metrics / runtime / results_path /
schema_version). This wrapper bridges the two without requiring changes
to `run_spike.py`.

Usage:
    python3 write_envelope.py \\
        --legacy results/g3_100k.json \\
        --area-dir . \\
        --gate G3 --hypothesis H7.2

Writes `results/g3_<TS>.json` next to the legacy artifact.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from experiments._lib.results_writer import ResultEnvelope, write_result  # noqa: E402
from experiments._lib.runner import capture_run_context  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--legacy", required=True, help="Path to run_spike.py output JSON")
    p.add_argument("--area-dir", required=True, help="Experiment area directory")
    p.add_argument("--gate", default="G3")
    p.add_argument("--hypothesis", default="H7.2")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--notes", default=None)
    args = p.parse_args(argv)

    legacy_path = Path(args.legacy)
    legacy = json.loads(legacy_path.read_text())

    runtime = capture_run_context(
        gate=args.gate,
        hypothesis=args.hypothesis,
        seed=int(legacy.get("config", {}).get("seed", args.seed)),
    )

    metrics = {
        "p_value": legacy.get("p_value"),
        "separation_ratio": legacy.get("separation_ratio"),
        "mean_within_type_distance": legacy.get("mean_within_type_distance"),
        "mean_cross_type_distance": legacy.get("mean_cross_type_distance"),
        "mannwhitney_statistic": legacy.get("mannwhitney_statistic"),
        "typed_accuracy": legacy.get("typed_accuracy"),
        "untyped_accuracy": legacy.get("untyped_accuracy"),
        "accuracy_delta": legacy.get("accuracy_delta"),
        "typed_better": legacy.get("typed_better"),
        "typed_final_loss": legacy.get("typed_final_loss"),
        "untyped_final_loss": legacy.get("untyped_final_loss"),
        "corpus_size": legacy.get("config", {}).get("corpus_size"),
        "n_steps": legacy.get("config", {}).get("n_steps"),
    }

    envelope = ResultEnvelope(
        gate=args.gate,
        hypothesis=args.hypothesis,
        passed=bool(legacy.get("pass_g3")),
        metrics=metrics,
        runtime=runtime,
        notes=args.notes or legacy.get("interpretation"),
        extra={"legacy_path": str(legacy_path), "config": legacy.get("config", {})},
    )

    out = write_result(envelope, args.area_dir)
    print(f"wrote envelope: {out}")
    print(f"pass={envelope.passed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
