"""
run_area7.py — Orchestrator CLI for the Area 7 full run.

Usage
-----
# Small/CI run (fast):
python run_area7.py --n-blocks 10000 --n-steps 500

# Full run (100K blocks, 5K steps):
python run_area7.py --n-blocks 100000 --n-steps 5000

# Skip optional phases:
python run_area7.py --skip-staleness-curve --skip-throughput

All results are written to --output (default: results/area7_results.json).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Ensure local modules are importable when run from this directory.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from full_training import run_full_training
from onnx_production import run_onnx_roundtrip
from staleness_curve import simulate_staleness_curve
from throughput_comparison import benchmark_throughput


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Area 7 full run — differentiable graph model pipeline",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--n-blocks", type=int, default=10_000,
        help="Number of blocks in the synthetic corpus (100K for full run)",
    )
    parser.add_argument(
        "--n-steps", type=int, default=500,
        help="Training gradient steps (5000 for full run)",
    )
    parser.add_argument(
        "--embedding-dim", type=int, default=128,
        help="Node embedding dimension (128; full scale = 1536)",
    )
    parser.add_argument(
        "--lr", type=float, default=1e-3,
        help="Adam learning rate",
    )
    parser.add_argument(
        "--eval-every", type=int, default=100,
        help="Evaluate every N steps",
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed",
    )
    parser.add_argument(
        "--output", type=str, default="results/area7_results.json",
        help="Output JSON path",
    )
    parser.add_argument(
        "--onnx-path", type=str, default="results/area7_model.onnx",
        help="ONNX model output path",
    )
    parser.add_argument(
        "--skip-staleness-curve", action="store_true",
        help="Skip staleness simulation (fast, deterministic — include by default)",
    )
    parser.add_argument(
        "--skip-throughput", action="store_true",
        help="Skip throughput benchmark (requires onnxruntime)",
    )
    parser.add_argument(
        "--live-graph-latency-ms", type=float, default=50.0,
        help="Live graph P50 latency in ms (from Area 3 measurements)",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()

    results: dict = {
        "config": vars(args),
        "phases": {},
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Phase 1 — H7.1: Full training run.
    # ------------------------------------------------------------------
    print(f"\n[Area 7] Phase 1/4 — H7.1: Training on {args.n_blocks:,} blocks "
          f"for {args.n_steps:,} steps...")
    t0 = time.perf_counter()
    training_results = run_full_training(
        n_blocks=args.n_blocks,
        embedding_dim=args.embedding_dim,
        n_steps=args.n_steps,
        lr=args.lr,
        eval_every=args.eval_every,
        seed=args.seed,
    )
    t_train = time.perf_counter() - t0
    training_results["wall_clock_sec"] = t_train
    results["phases"]["h7_1_training"] = training_results

    print(f"    H7.1 supported: {training_results['h7_1_supported']}")
    print(f"    Final clause accuracy: {training_results['final_clause_accuracy']:.4f} "
          f"(+{training_results['improvement_clause']:+.4f})")
    print(f"    Final contradiction accuracy: {training_results['final_contradiction_accuracy']:.4f} "
          f"(+{training_results['improvement_contradiction']:+.4f})")
    print(f"    Training wall-clock: {t_train:.1f}s")

    # ------------------------------------------------------------------
    # Phase 2 — H7.3: ONNX round-trip at scale.
    # ------------------------------------------------------------------
    print(f"\n[Area 7] Phase 2/4 — H7.3: ONNX round-trip (exporting to {args.onnx_path})...")

    # We need the trained model object. Re-create it from the training config
    # and re-run a minimal pass (or just use the generate + export pipeline).
    # The simplest approach: re-train with the same seed but only 1 step to
    # reconstruct the model, then re-load. Since run_full_training doesn't
    # return the model object directly, we use a helper.
    from _run_helpers import build_trained_model_and_data

    model, data = build_trained_model_and_data(
        n_blocks=args.n_blocks,
        embedding_dim=args.embedding_dim,
        n_steps=args.n_steps,
        lr=args.lr,
        seed=args.seed,
    )

    t0 = time.perf_counter()
    onnx_results = run_onnx_roundtrip(
        model=model,
        data=data,
        n_eval_pairs=2_000,
        onnx_path=args.onnx_path,
    )
    t_onnx = time.perf_counter() - t0
    onnx_results["wall_clock_sec"] = t_onnx
    results["phases"]["h7_3_onnx"] = onnx_results

    print(f"    H7.3 supported: {onnx_results['h7_3_supported']}")
    print(f"    PyTorch accuracy: {onnx_results['pytorch_accuracy']:.4f}")
    print(f"    ONNX accuracy:    {onnx_results['onnx_accuracy']:.4f}")
    print(f"    Accuracy delta:   {onnx_results['accuracy_delta']:.6f}")
    print(f"    ONNX model size:  {onnx_results['onnx_model_size_mb']:.2f} MB")

    # ------------------------------------------------------------------
    # Phase 3 — H7.4: Staleness curve.
    # ------------------------------------------------------------------
    if not args.skip_staleness_curve:
        print("\n[Area 7] Phase 3/4 — H7.4: Staleness curve simulation...")
        t0 = time.perf_counter()
        staleness_results = simulate_staleness_curve(
            update_rates_per_day=[10, 100, 1_000, 10_000],
            n_days=14,
            initial_accuracy=training_results["final_contradiction_accuracy"],
            output_dir=str(output_path.parent),
        )
        t_staleness = time.perf_counter() - t0
        # Convert int keys to string for JSON serialisation.
        staleness_serialisable = {
            str(k): v for k, v in staleness_results.items()
            if k != "decay_curves_plotted"
        }
        staleness_serialisable["decay_curves_plotted"] = staleness_results.get(
            "decay_curves_plotted", False
        )
        staleness_serialisable["wall_clock_sec"] = t_staleness
        results["phases"]["h7_4_staleness"] = staleness_serialisable
        print(f"    Staleness curve plotted: {staleness_results.get('decay_curves_plotted', False)}")
    else:
        print("\n[Area 7] Phase 3/4 — H7.4: Staleness curve SKIPPED (--skip-staleness-curve)")
        results["phases"]["h7_4_staleness"] = {"skipped": True}

    # ------------------------------------------------------------------
    # Phase 4 — H7.5: Throughput comparison.
    # ------------------------------------------------------------------
    if not args.skip_throughput:
        print(f"\n[Area 7] Phase 4/4 — H7.5: Throughput benchmark ({args.onnx_path})...")
        try:
            t0 = time.perf_counter()
            throughput_results = benchmark_throughput(
                onnx_path=args.onnx_path,
                n_queries=1_000,
                k=10,
                live_graph_latency_ms=args.live_graph_latency_ms,
            )
            t_bench = time.perf_counter() - t0
            throughput_results["wall_clock_sec"] = t_bench
            results["phases"]["h7_5_throughput"] = throughput_results
            print(f"    H7.5 supported: {throughput_results['h7_5_supported']}")
            print(f"    ONNX P50:        {throughput_results['onnx_p50_ms']:.2f} ms")
            print(f"    Live graph P50:  {throughput_results['live_graph_p50_ms']:.1f} ms")
            print(f"    Throughput ratio: {throughput_results['throughput_ratio']:.1f}x")
        except Exception as exc:
            print(f"    Throughput benchmark failed: {exc}")
            results["phases"]["h7_5_throughput"] = {"error": str(exc)}
    else:
        print("\n[Area 7] Phase 4/4 — H7.5: Throughput benchmark SKIPPED (--skip-throughput)")
        results["phases"]["h7_5_throughput"] = {"skipped": True}

    # ------------------------------------------------------------------
    # Summary.
    # ------------------------------------------------------------------
    print("\n[Area 7] Summary:")
    print(f"    H7.1 (training convergence): {training_results.get('h7_1_supported', '?')}")
    print(f"    H7.3 (lossless ONNX):        {onnx_results.get('h7_3_supported', '?')}")
    if "h7_4_staleness" in results["phases"] and not results["phases"]["h7_4_staleness"].get("skipped"):
        print(f"    H7.4 (staleness curve):      plotted={staleness_results.get('decay_curves_plotted', False)}")
    if "h7_5_throughput" in results["phases"] and not results["phases"]["h7_5_throughput"].get("skipped"):
        print(f"    H7.5 (throughput ratio):     {results['phases']['h7_5_throughput'].get('h7_5_supported', '?')}")

    # ------------------------------------------------------------------
    # Write results.
    # ------------------------------------------------------------------
    with open(str(output_path), "w") as f:
        json.dump(results, f, indent=2, default=_json_default)

    print(f"\n[Area 7] Results written to {output_path}")


def _json_default(obj):
    """JSON serialisation fallback for non-serialisable types."""
    if hasattr(obj, "tolist"):
        return obj.tolist()
    if hasattr(obj, "item"):
        return obj.item()
    return str(obj)


if __name__ == "__main__":
    main()
