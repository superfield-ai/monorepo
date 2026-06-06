"""
run_spike.py — Main entry point for the G0 differentiability spike.

Gate G0 / H7.1 kill criterion:
    Does the typed-link message-passing forward pass converge (loss decreases
    monotonically within 1K gradient steps on a 10K-block synthetic corpus)?

Usage:
    python run_spike.py [--n-steps 1000] [--seed 42] [--output results/g0_result.json]

Exit code:
    0  — G0 PASS: loss decreased monotonically → proceed to Phase 1A (differentiable program)
    1  — G0 FAIL: loss did not decrease → revert to Phase 1B (retrieval-only program)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="G0 differentiability spike — H7.1 kill criterion"
    )
    parser.add_argument(
        "--n-steps",
        type=int,
        default=1000,
        help="Number of gradient steps (default: 1000)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="results/g0_result.json",
        help="Path for JSON results output (default: results/g0_result.json)",
    )
    parser.add_argument(
        "--no-plot",
        action="store_true",
        default=False,
        help="Skip loss curve plot generation",
    )
    parser.add_argument(
        "--no-canonical-envelope",
        action="store_true",
        default=False,
        help="Skip writing the canonical experiments/_lib envelope (used by tests).",
    )
    parser.add_argument(
        "--lr",
        type=float,
        default=1e-3,
        help="Learning rate (default: 1e-3)",
    )
    parser.add_argument(
        "--n-nodes",
        type=int,
        default=10_000,
        help="Number of synthetic graph nodes (default: 10000)",
    )
    parser.add_argument(
        "--n-edges",
        type=int,
        default=50_000,
        help="Number of synthetic graph edges (default: 50000)",
    )
    return parser.parse_args()


def _hardware_info() -> dict:
    """Collect hardware/runtime metadata."""
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    info = {
        "device": device,
        "torch_version": torch.__version__,
    }
    if device == "cuda":
        info["cuda_device_name"] = torch.cuda.get_device_name(0)
        info["cuda_version"] = torch.version.cuda
    return info


def _plot_loss_curve(loss_curve: list[float], output_path: Path) -> None:
    """Generate and save the loss curve plot."""
    try:
        import matplotlib
        matplotlib.use("Agg")  # Non-interactive backend — safe for headless runs.
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not available — skipping plot.", file=sys.stderr)
        return

    fig, axes = plt.subplots(1, 2, figsize=(12, 4))

    # Left: full loss curve.
    axes[0].plot(loss_curve, color="steelblue", linewidth=0.8, alpha=0.9)
    axes[0].set_xlabel("Gradient step")
    axes[0].set_ylabel("BCEWithLogitsLoss")
    axes[0].set_title("G0 — Loss curve (full)")
    axes[0].grid(True, alpha=0.3)

    # Right: smoothed (rolling average over 20 steps).
    window = min(20, len(loss_curve) // 10 or 1)
    if len(loss_curve) >= window:
        smoothed = [
            sum(loss_curve[max(0, i - window):i + 1]) / (min(i + 1, window))
            for i in range(len(loss_curve))
        ]
        axes[1].plot(smoothed, color="darkorange", linewidth=1.2)
        axes[1].set_xlabel("Gradient step")
        axes[1].set_ylabel("BCEWithLogitsLoss (smoothed)")
        axes[1].set_title(f"G0 — Loss curve (rolling avg {window})")
        axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Loss curve saved to: {output_path}")


def main() -> int:
    """
    Run the G0 spike and return exit code (0=PASS, 1=FAIL).
    """
    args = _parse_args()

    # Add the experiment directory to sys.path so local imports work regardless
    # of where the script is called from.
    exp_dir = Path(__file__).resolve().parent
    if str(exp_dir) not in sys.path:
        sys.path.insert(0, str(exp_dir))

    print("=" * 60)
    print("G0 Differentiability Spike — H7.1 Kill Criterion")
    print("=" * 60)

    # ------------------------------------------------------------------
    # 1. Hardware info.
    # ------------------------------------------------------------------
    hw = _hardware_info()
    print(f"Device   : {hw['device']}")
    print(f"PyTorch  : {hw['torch_version']}")
    if "cuda_device_name" in hw:
        print(f"GPU      : {hw['cuda_device_name']}")
    print()

    # ------------------------------------------------------------------
    # 2. Generate synthetic corpus.
    # ------------------------------------------------------------------
    print(f"Generating synthetic graph: {args.n_nodes:,} nodes, {args.n_edges:,} edges ...")
    t0 = time.perf_counter()
    from data import generate_synthetic_graph
    data = generate_synthetic_graph(
        n_nodes=args.n_nodes,
        n_edges=args.n_edges,
        seed=args.seed,
    )
    print(f"  Nodes       : {data.n_nodes:,}")
    print(f"  Edges       : {data.n_edges:,}")
    print(f"  Labeled pairs: {len(data.pair_labels):,}")
    print(f"  Generated in {time.perf_counter() - t0:.1f}s")
    print()

    # ------------------------------------------------------------------
    # 3. Build model.
    # ------------------------------------------------------------------
    from model import TypedLinkGraphModel
    model = TypedLinkGraphModel(
        node_feat_dim=data.x.shape[1],
        hidden_dim=64,
        out_dim=32,
        type_emb_dim=16,
        num_layers=2,
        dropout=0.1,
    )
    n_params = sum(p.numel() for p in model.parameters())
    print(f"Model parameters: {n_params:,}")
    print()

    # ------------------------------------------------------------------
    # 4. Train.
    # ------------------------------------------------------------------
    print(f"Training for {args.n_steps} steps at lr={args.lr} ...")
    t1 = time.perf_counter()
    from train import train
    results = train(
        model=model,
        data=data,
        n_steps=args.n_steps,
        lr=args.lr,
        verbose=True,
    )
    elapsed = time.perf_counter() - t1
    print()
    print(f"Training complete in {elapsed:.1f}s  ({elapsed / args.n_steps * 1000:.1f}ms/step)")

    # ------------------------------------------------------------------
    # 5. Summarise results.
    # ------------------------------------------------------------------
    passed = results["monotone_decrease"]
    print()
    print("=" * 60)
    print(f"G0 RESULT : {'PASS' if passed else 'FAIL'}")
    print(f"  Initial loss    : {results['initial_loss']:.4f}")
    print(f"  Final loss      : {results['final_loss']:.4f}")
    print(f"  Monotone        : {results['monotone_decrease']}")
    print(f"  Gradient health : {results['gradient_health']}")
    if results["warnings"]:
        print(f"  Warnings ({len(results['warnings'])}):")
        for w in results["warnings"][:5]:
            print(f"    - {w}")
    print("=" * 60)
    print()
    if passed:
        print("→ EXIT 0: G0 passes. Proceed to Phase 1A (differentiable program).")
    else:
        print("→ EXIT 1: G0 fails. Revert to Phase 1B (retrieval-only program).")

    # ------------------------------------------------------------------
    # 6. Write JSON output.
    # ------------------------------------------------------------------
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    output_doc = {
        "pass": passed,
        "loss_curve": results["loss_curve"],
        "monotone_decrease": results["monotone_decrease"],
        "monotone_decrease_strict": results.get("monotone_decrease_strict"),
        "monotone_decrease_smoothed": results.get("monotone_decrease_smoothed"),
        "smooth_window": results.get("smooth_window"),
        "gradient_health": results["gradient_health"],
        "n_steps": args.n_steps,
        "final_loss": results["final_loss"],
        "initial_loss": results["initial_loss"],
        "hardware": hw,
        "seed": args.seed,
        "n_nodes": args.n_nodes,
        "n_edges": args.n_edges,
        "gradient_norms": results["gradient_norms"],
        "training_warnings": results["warnings"],
        "elapsed_seconds": elapsed,
    }

    with open(output_path, "w") as f:
        json.dump(output_doc, f, indent=2)
    print(f"Results written to: {output_path}")

    # ------------------------------------------------------------------
    # 6b. Emit canonical phase-0 envelope via experiments/_lib harness.
    # ------------------------------------------------------------------
    if args.no_canonical_envelope:
        print("Canonical envelope skipped (--no-canonical-envelope).")
    else:
        try:
            # Repo root is two levels above this experiment dir.
            repo_root = exp_dir.parent.parent
            if str(repo_root) not in sys.path:
                sys.path.insert(0, str(repo_root))
            from experiments._lib import (  # noqa: E402
                ResultEnvelope,
                capture_run_context,
                write_result,
            )

            ctx = capture_run_context(gate="G0", hypothesis="H7.1", seed=args.seed)
            envelope = ResultEnvelope(
                gate="G0",
                hypothesis="H7.1",
                passed=passed,
                metrics={
                    "monotone_decrease": results["monotone_decrease"],
                    "monotone_decrease_strict": results.get("monotone_decrease_strict"),
                    "monotone_decrease_smoothed": results.get("monotone_decrease_smoothed"),
                    "smooth_window": results.get("smooth_window"),
                    "initial_loss": results["initial_loss"],
                    "final_loss": results["final_loss"],
                    "loss_delta": results["initial_loss"] - results["final_loss"],
                    "gradient_health": results["gradient_health"],
                    "n_steps": args.n_steps,
                    "n_nodes": args.n_nodes,
                    "n_edges": args.n_edges,
                    "elapsed_seconds": elapsed,
                    "ms_per_step": elapsed / args.n_steps * 1000.0 if args.n_steps else None,
                    "lr": args.lr,
                },
                runtime=ctx,
                notes=(
                    "G0 / H7.1 kill criterion: typed-link message-passing forward + "
                    "1K-step backprop on 10K-block synthetic corpus."
                ),
                extra={
                    "loss_curve": results["loss_curve"],
                    "gradient_norms": results["gradient_norms"],
                    "training_warnings": results["warnings"],
                    "legacy_results_path": str(output_path.as_posix()),
                },
            )
            envelope_path = write_result(envelope, exp_dir)
            print(f"Canonical envelope written to: {envelope_path}")
        except Exception as exc:  # noqa: BLE001 — never block the spike on harness errors
            print(f"warning: failed to write canonical envelope: {exc}", file=sys.stderr)

    # ------------------------------------------------------------------
    # 7. Plot (optional).
    # ------------------------------------------------------------------
    if not args.no_plot:
        plot_path = output_path.parent / "g0_loss_curve.png"
        _plot_loss_curve(results["loss_curve"], plot_path)

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
