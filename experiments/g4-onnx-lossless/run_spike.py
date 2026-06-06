"""
run_spike.py — Main entry point for the G4 ONNX losslessness spike.

Gate G4 / H7.3:
    Does ONNX-serialized TypedLinkGraphModel produce outputs within 1%
    accuracy delta of the live PyTorch model?

Usage:
    python run_spike.py \\
        --n-training-steps 500 \\
        --seed 42 \\
        --output results/g4_result.json

Steps:
    1. Generate synthetic 10K-block corpus (reuses g0-differentiability/data.py)
    2. Train the TypedLinkGraphModel for n_training_steps
    3. Export trained model to ONNX
    4. Run losslessness evaluation
    5. Write results JSON, exit 0 if pass, 1 if fail

Exit code:
    0 — G4 PASS: accuracy_delta < 1% → ONNX serialization is lossless
    1 — G4 FAIL: accuracy_delta >= 1% → frozen export requires distillation framing
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# sys.path setup — import from g0-differentiability without installing it.
# ---------------------------------------------------------------------------
_HERE = Path(__file__).resolve().parent
_G0_DIR = _HERE.parent / "g0-differentiability"
if str(_G0_DIR) not in sys.path:
    sys.path.insert(0, str(_G0_DIR))

if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="G4 ONNX losslessness spike — H7.3"
    )
    parser.add_argument(
        "--n-training-steps",
        type=int,
        default=1000,
        help=(
            "Number of gradient steps to train the G0 model (default: 1000, "
            "matching the G0 / H7.1 kill-criterion spec from PR #83)"
        ),
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
        default="results/g4_result.json",
        help="Path for JSON results output (default: results/g4_result.json)",
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
    parser.add_argument(
        "--n-eval-pairs",
        type=int,
        default=500,
        help="Number of pairs for losslessness eval (default: 500)",
    )
    parser.add_argument(
        "--opset-version",
        type=int,
        default=17,
        help="ONNX opset version (default: 17)",
    )
    parser.add_argument(
        "--lr",
        type=float,
        default=1e-3,
        help="Training learning rate (default: 1e-3)",
    )
    parser.add_argument(
        "--g0-checkpoint",
        type=str,
        default=None,
        help=(
            "Optional path to a trained G0 model state_dict (.pt). "
            "If provided, training is skipped and these weights are loaded "
            "directly — exercising the actual G0 model from PR #83 rather "
            "than re-training a fresh one."
        ),
    )
    parser.add_argument(
        "--save-checkpoint",
        type=str,
        default=None,
        help=(
            "Optional path to write the trained G0 model state_dict to. "
            "Useful so a subsequent run can pass --g0-checkpoint and skip "
            "the training step."
        ),
    )
    parser.add_argument(
        "--no-canonical-envelope",
        action="store_true",
        default=False,
        help="Skip writing the canonical experiments/_lib envelope.",
    )
    return parser.parse_args()


def _hardware_info() -> dict:
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


def main() -> int:
    args = _parse_args()

    print("=" * 60)
    print("G4 ONNX Losslessness Spike — H7.3")
    print("=" * 60)

    # ------------------------------------------------------------------
    # Hardware info.
    # ------------------------------------------------------------------
    hw = _hardware_info()
    print(f"Device  : {hw['device']}")
    print(f"PyTorch : {hw['torch_version']}")
    print()

    # ------------------------------------------------------------------
    # 1. Generate synthetic corpus (reuse g0-differentiability/data.py).
    # ------------------------------------------------------------------
    print(f"Generating synthetic graph: {args.n_nodes:,} nodes, {args.n_edges:,} edges ...")
    t0 = time.perf_counter()

    from data import generate_synthetic_graph
    data = generate_synthetic_graph(
        n_nodes=args.n_nodes,
        n_edges=args.n_edges,
        seed=args.seed,
    )
    print(f"  Nodes         : {data.n_nodes:,}")
    print(f"  Edges         : {data.n_edges:,}")
    print(f"  Labeled pairs : {len(data.pair_labels):,}")
    print(f"  Generated in {time.perf_counter() - t0:.1f}s")
    print()

    # ------------------------------------------------------------------
    # 2. Train the TypedLinkGraphModel (G0 forward pass).
    # ------------------------------------------------------------------
    import torch
    from model import TypedLinkGraphModel
    from train import train as g0_train

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

    if args.g0_checkpoint:
        # Load the actual trained G0 model rather than re-training.
        ckpt_path = Path(args.g0_checkpoint)
        if not ckpt_path.exists():
            print(f"ERROR: G0 checkpoint not found: {ckpt_path}")
            return 1
        print(f"Loading G0 checkpoint: {ckpt_path}")
        state = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        model.load_state_dict(state)
        train_results = {
            "initial_loss": float("nan"),
            "final_loss": float("nan"),
            "monotone_decrease": None,
            "gradient_health": "skipped (loaded from checkpoint)",
        }
        elapsed_train = 0.0
        t1 = time.perf_counter()
    else:
        print(f"Training for {args.n_training_steps} steps at lr={args.lr} ...")
        t1 = time.perf_counter()
        train_results = g0_train(
            model=model,
            data=data,
            n_steps=args.n_training_steps,
            lr=args.lr,
            verbose=True,
        )
        elapsed_train = time.perf_counter() - t1
        print(f"Training complete in {elapsed_train:.1f}s")
        print(f"  Initial loss : {train_results['initial_loss']:.4f}")
        print(f"  Final loss   : {train_results['final_loss']:.4f}")
        print()

    # Persist the trained model so subsequent runs can reuse it.
    if args.save_checkpoint:
        save_path = Path(args.save_checkpoint)
        save_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save(model.state_dict(), save_path)
        print(f"Trained G0 model saved to: {save_path}")

    # ------------------------------------------------------------------
    # 3. Export trained model to ONNX.
    # ------------------------------------------------------------------
    from export import export_to_onnx

    output_dir = Path(args.output).parent
    onnx_path = str(output_dir / "g4_model.onnx")

    print(f"Exporting model to ONNX: {onnx_path} ...")
    t2 = time.perf_counter()
    export_result = export_to_onnx(
        model=model,
        sample_data=data,
        output_path=onnx_path,
        opset_version=args.opset_version,
    )
    elapsed_export = time.perf_counter() - t2
    print(f"  Export success     : {export_result['export_success']}")
    print(f"  Validation passed  : {export_result['validation_passed']}")
    print(f"  Fallback used      : {export_result['fallback_used']}")
    print(f"  ONNX size          : {export_result['onnx_model_size_bytes'] / 1024:.1f} KB")
    print(f"  Exported in {elapsed_export:.1f}s")
    print()

    if not export_result["export_success"]:
        print("ERROR: ONNX export failed. Cannot proceed with losslessness eval.")
        return 1

    # ------------------------------------------------------------------
    # 4. Run losslessness evaluation.
    # ------------------------------------------------------------------
    from eval_losslessness import evaluate_losslessness
    from inference import ONNXGraphInference, NumpyFallbackInference

    # Choose inference path based on export variant.
    if export_result["fallback_used"]:
        print("Using NumPy fallback inference path (torch.onnx.export failed).")
        npz_path = export_result["fallback_npz_path"]
        onnx_infer = NumpyFallbackInference(npz_path)
    else:
        print("Using ONNX Runtime inference path.")
        onnx_infer = ONNXGraphInference(
            onnx_path=onnx_path,
            npz_path=export_result.get("fallback_npz_path"),
        )

    print(f"Evaluating losslessness on {args.n_eval_pairs} pairs ...")
    t3 = time.perf_counter()
    eval_result = evaluate_losslessness(
        pytorch_model=model,
        onnx_inference=onnx_infer,
        data=data,
        n_eval_pairs=args.n_eval_pairs,
        seed=args.seed,
    )
    elapsed_eval = time.perf_counter() - t3

    # ------------------------------------------------------------------
    # 5. Print and write results.
    # ------------------------------------------------------------------
    passed = eval_result["pass_g4"]

    print()
    print("=" * 60)
    print(f"G4 RESULT : {'PASS' if passed else 'FAIL'}")
    print(f"  Accuracy (PyTorch) : {eval_result['accuracy_pytorch']:.4f}")
    print(f"  Accuracy (ONNX)    : {eval_result['accuracy_onnx']:.4f}")
    print(f"  Accuracy delta     : {eval_result['accuracy_delta']:.4f}  (threshold: < 0.01)")
    print(f"  F1 (PyTorch)       : {eval_result['f1_pytorch']:.4f}")
    print(f"  F1 (ONNX)          : {eval_result['f1_onnx']:.4f}")
    print(f"  F1 delta           : {eval_result['f1_delta']:.4f}  (threshold: < 0.01)")
    print(f"  Max logit diff     : {eval_result['max_logit_diff']:.6f}")
    print(f"  Mean logit diff    : {eval_result['mean_logit_diff']:.6f}")
    print(f"  Eval pairs         : {eval_result['n_eval_pairs']}")
    print(f"  Pass G4            : {passed}")
    print("=" * 60)
    print()

    if passed:
        print("→ EXIT 0: G4 passes. ONNX serialization is lossless (< 1% accuracy delta).")
        print("  Frozen export product tier is valid.")
    else:
        print("→ EXIT 1: G4 fails. Accuracy delta >= 1%.")
        print("  Frozen export requires distillation framing.")

    # Write JSON.
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    output_doc = {
        "pass": passed,
        "gate": "G4",
        "hypothesis": "H7.3",
        "eval": eval_result,
        "export": {
            k: v for k, v in export_result.items()
            if k not in ("onnx_path", "fallback_npz_path")  # paths are machine-specific
        },
        "training": {
            "n_steps": args.n_training_steps,
            "final_loss": train_results["final_loss"],
            "initial_loss": train_results["initial_loss"],
            "monotone_decrease": train_results["monotone_decrease"],
            "gradient_health": train_results["gradient_health"],
        },
        "corpus": {
            "n_nodes": args.n_nodes,
            "n_edges": args.n_edges,
            "n_eval_pairs": args.n_eval_pairs,
        },
        "hardware": hw,
        "seed": args.seed,
        "elapsed_seconds": {
            "data_generation": round(t1 - t0, 2),
            "training": round(elapsed_train, 2),
            "export": round(elapsed_export, 2),
            "eval": round(elapsed_eval, 2),
        },
    }

    with open(output_path, "w") as f:
        json.dump(output_doc, f, indent=2)
    print(f"Results written to: {output_path}")

    # ------------------------------------------------------------------
    # 6. Emit canonical phase-0 envelope via experiments/_lib harness.
    # ------------------------------------------------------------------
    if not args.no_canonical_envelope:
        try:
            repo_root = _HERE.parent.parent
            if str(repo_root) not in sys.path:
                sys.path.insert(0, str(repo_root))
            from experiments._lib import (  # noqa: E402
                ResultEnvelope,
                capture_run_context,
                write_result,
            )

            ctx = capture_run_context(gate="G4", hypothesis="H7.3", seed=args.seed)
            envelope = ResultEnvelope(
                gate="G4",
                hypothesis="H7.3",
                passed=passed,
                metrics={
                    "accuracy_pytorch": eval_result["accuracy_pytorch"],
                    "accuracy_onnx": eval_result["accuracy_onnx"],
                    "accuracy_delta": eval_result["accuracy_delta"],
                    "f1_pytorch": eval_result["f1_pytorch"],
                    "f1_onnx": eval_result["f1_onnx"],
                    "f1_delta": eval_result["f1_delta"],
                    "max_logit_diff": eval_result["max_logit_diff"],
                    "mean_logit_diff": eval_result["mean_logit_diff"],
                    "n_eval_pairs": eval_result["n_eval_pairs"],
                    "pass_threshold_accuracy": eval_result.get(
                        "pass_threshold_accuracy", 0.01
                    ),
                    "pass_threshold_f1": eval_result.get(
                        "pass_threshold_f1", 0.01
                    ),
                    "n_nodes": args.n_nodes,
                    "n_edges": args.n_edges,
                    "n_training_steps": args.n_training_steps,
                    "training_initial_loss": train_results["initial_loss"],
                    "training_final_loss": train_results["final_loss"],
                    "training_monotone_decrease": train_results[
                        "monotone_decrease"
                    ],
                    "onnx_model_size_bytes": export_result[
                        "onnx_model_size_bytes"
                    ],
                    "onnx_export_fallback_used": export_result["fallback_used"],
                    "onnx_validation_passed": export_result[
                        "validation_passed"
                    ],
                    "elapsed_seconds_total": round(
                        (t1 - t0) + elapsed_train + elapsed_export + elapsed_eval,
                        2,
                    ),
                },
                runtime=ctx,
                notes=(
                    "G4 / H7.3 ONNX losslessness: trained TypedLinkGraphModel "
                    "(G0 architecture from PR #83) at 10K-block / 1K-step spec, "
                    "exported to ONNX, then compared PyTorch vs. ONNX on a "
                    "held-out eval set. Pass criterion: < 1% accuracy delta "
                    "AND < 1% attribution F1 delta."
                ),
                extra={
                    "legacy_results_path": str(output_path.as_posix()),
                    "g0_checkpoint_loaded": bool(args.g0_checkpoint),
                    "g0_checkpoint_path": (
                        str(args.g0_checkpoint) if args.g0_checkpoint else None
                    ),
                },
            )
            envelope_path = write_result(envelope, _HERE)
            print(f"Canonical envelope written to: {envelope_path}")
        except Exception as exc:  # noqa: BLE001
            print(
                f"warning: failed to write canonical envelope: {exc}",
                file=sys.stderr,
            )

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
