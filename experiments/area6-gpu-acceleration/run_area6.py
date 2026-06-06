"""
run_area6.py — Orchestrator CLI for Area 6 GPU acceleration experiments.

Runs H6.2–H6.6 experiments and writes results to a JSON file.

Usage:
    python run_area6.py \\
        --n-blocks 1000000 \\
        --vram-fraction 0.10 \\
        --skip-gpu \\
        --output results/area6_results.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np


def _banner(title: str) -> None:
    width = 72
    print("\n" + "=" * width)
    print(f"  {title}")
    print("=" * width)


def run_h6_2(skip_gpu: bool, output: dict) -> None:
    from embedding_latency import measure_embedding_latency

    _banner("H6.2 — Embedding latency: GPU vs CPU vs OpenAI mock")
    backends = ["openai_mock", "cpu_local"]
    if not skip_gpu:
        backends.append("gpu_local")

    # Use synthetic texts to avoid network calls
    texts = ["The quick brown fox jumps over the lazy dog. " * 10] * 512

    result = measure_embedding_latency(
        texts=texts,
        batch_sizes=[1, 8, 32, 128, 512],
        backends=backends,
    )

    print(f"  Signal: {result['h6_2_signal']}")
    output["h6_2"] = result


def run_h6_3(output: dict) -> None:
    from sidecar_vs_inprocess import simulate_sidecar_comparison

    _banner("H6.3 — Sidecar vs in-process GPU IPC overhead")
    result = simulate_sidecar_comparison(n_queries=10_000)
    print(f"  In-process p50: {result['inprocess']['p50_ms']:.2f}ms")
    print(f"  Sidecar    p50: {result['sidecar']['p50_ms']:.2f}ms")
    print(f"  Within 20%:     {result['sidecar_within_20pct']}")
    print(f"  H6.3 supported: {result['h6_3_supported']}")
    output["h6_3"] = result


def run_h6_4(output: dict) -> None:
    from batch_sweep import run_batch_sweep

    _banner("H6.4 — Batch size throughput sweep (Amdahl model)")
    result = run_batch_sweep(
        batch_sizes=[1, 8, 32, 128, 512],
        single_query_ms=5.0,
        throughput_model="amdahl",
        parallelism_fraction=0.90,
    )
    for bs in [1, 8, 32, 128, 512]:
        r = result[bs]
        print(
            f"  batch={bs:>4}: {r['throughput_relative']:.2f}x throughput, "
            f"latency={r['latency_ms']:.2f}ms, queue={r['queuing_latency_ms']:.1f}ms"
        )
    print(f"  H6.4 supported:    {result['h6_4_supported']}")
    print(f"  Optimal batch size: {result['optimal_batch_size']}")
    output["h6_4"] = result


def run_h6_5_h6_6(n_blocks: int, vram_fraction: float, output: dict) -> None:
    from hot_shard_simulation import simulate_vram_tiering

    _banner(f"H6.5/H6.6 — VRAM tiering simulation ({n_blocks:,} blocks, {vram_fraction:.0%} VRAM)")
    result = simulate_vram_tiering(
        n_blocks=n_blocks,
        vram_capacity_fraction=vram_fraction,
        access_distribution="zipf",
        zipf_alpha=1.2,
        n_queries=10_000,
    )
    print(f"  hot_shard  throughput: {result['hot_shard']['throughput_relative']:.2f}x  "
          f"hit_rate={result['hot_shard']['hit_rate']:.2%}")
    print(f"  uvm        throughput: {result['uvm']['throughput_relative']:.2f}x  "
          f"hit_rate={result['uvm']['hit_rate']:.2%}")
    print(f"  cpu_fallback          1.00x")
    print(f"  Zipf alpha fit:       {result['zipf_alpha_fit']:.3f}")
    print(f"  Top 10% serves:       {result['top_10pct_serves_pct_queries']:.2%}")
    print(f"  H6.5 supported:       {result['h6_5_supported']}")
    print(f"  H6.6 supported:       {result['h6_6_supported']}")
    output["h6_5_h6_6"] = result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Area 6 GPU acceleration experiments orchestrator"
    )
    parser.add_argument(
        "--n-blocks",
        type=int,
        default=1_000_000,
        help="Number of blocks to simulate (default: 1,000,000)",
    )
    parser.add_argument(
        "--vram-fraction",
        type=float,
        default=0.10,
        help="Fraction of corpus that fits in VRAM (default: 0.10)",
    )
    parser.add_argument(
        "--skip-gpu",
        action="store_true",
        help="Skip GPU backends (use when no CUDA hardware available)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="results/area6_results.json",
        help="Output JSON path (default: results/area6_results.json)",
    )
    args = parser.parse_args()

    output: dict = {
        "meta": {
            "n_blocks": args.n_blocks,
            "vram_fraction": args.vram_fraction,
            "skip_gpu": args.skip_gpu,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    }

    t0 = time.perf_counter()

    run_h6_2(skip_gpu=args.skip_gpu, output=output)
    run_h6_3(output=output)
    run_h6_4(output=output)
    run_h6_5_h6_6(
        n_blocks=args.n_blocks,
        vram_fraction=args.vram_fraction,
        output=output,
    )

    elapsed = time.perf_counter() - t0
    _banner(f"Done ({elapsed:.1f}s)")

    # Write results
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, default=str)
    print(f"  Results written to: {out_path}")


if __name__ == "__main__":
    main()
