"""
run_spike.py — Main entry point for the G3 typed-link gradient signal spike.

Gate G3 / H7.2: Do `contradicts` and `supports` edge types develop statistically
distinct learned weight profiles during gradient descent?

CLI:
    python run_spike.py \\
        --n-steps 500 \\
        --corpus-size 10000 \\
        --seed 42 \\
        --output results/g3_result.json

Exit codes:
    0  G3 PASS (p < 0.05, typed link types carry independent gradient signal)
    1  G3 FAIL (p >= 0.05, typed links collapse; reduce to untyped GNN)

Steps:
    1. Generate synthetic corpus (from G0 data.py)
    2. Train TypedLinkGraphModel for n_steps
    3. Measure edge type divergence (Mann-Whitney U)
    4. Train UntypedGNNModel for same n_steps
    5. Compare typed vs. untyped accuracy
    6. Write results JSON
    7. Generate PCA visualisation of type embedding vectors
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import torch
import numpy as np

# G0 utilities on sys.path so we can import data and model.
_G0_ROOT = Path(__file__).resolve().parent.parent / "g0-differentiability"
_G3_ROOT = Path(__file__).resolve().parent
if str(_G0_ROOT) not in sys.path:
    sys.path.insert(0, str(_G0_ROOT))
if str(_G3_ROOT) not in sys.path:
    sys.path.insert(0, str(_G3_ROOT))

from data import generate_synthetic_graph          # noqa: E402
from model import TypedLinkGraphModel              # noqa: E402
from signal_measurement import (                   # noqa: E402
    measure_edge_type_divergence,
    compare_typed_vs_untyped,
)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="G3 typed-link gradient signal spike")
    p.add_argument("--n-steps", type=int, default=500,
                   help="Gradient steps for training (default 500; use 100 for quick test)")
    p.add_argument("--corpus-size", type=int, default=10_000,
                   help="Number of synthetic nodes (default 10K; use 100K for full run)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", type=str, default="results/g3_result.json")
    p.add_argument("--no-plot", action="store_true",
                   help="Skip matplotlib PCA plot (useful in headless CI)")
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--hidden-dim", type=int, default=64)
    p.add_argument("--out-dim", type=int, default=32)
    p.add_argument("--type-emb-dim", type=int, default=16)
    return p


def _generate_pca_plot(
    type_embeddings: dict[str, list],
    output_path: Path,
) -> None:
    """Generate a PCA plot of the 5 type embedding vectors."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from sklearn.decomposition import PCA  # type: ignore
    except ImportError:
        # sklearn optional — fall back to manual 2-component projection
        _generate_pca_plot_no_sklearn(type_embeddings, output_path)
        return

    names = list(type_embeddings.keys())
    vecs = np.array([type_embeddings[n] for n in names], dtype=np.float32)

    pca = PCA(n_components=2)
    coords = pca.fit_transform(vecs)

    fig, ax = plt.subplots(figsize=(6, 5))
    colors = ["tab:blue", "tab:orange", "tab:green", "tab:red", "tab:purple"]
    for i, (name, (px, py)) in enumerate(zip(names, coords)):
        ax.scatter(px, py, color=colors[i], s=120, zorder=3)
        ax.annotate(name, (px, py), textcoords="offset points", xytext=(6, 4),
                    fontsize=9, color=colors[i])

    ax.set_title("G3: PCA of Learned Type Embedding Vectors (after training)")
    ax.set_xlabel("PC1")
    ax.set_ylabel("PC2")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(str(output_path), dpi=150)
    plt.close(fig)
    print(f"  PCA plot saved to {output_path}")


def _generate_pca_plot_no_sklearn(
    type_embeddings: dict[str, list],
    output_path: Path,
) -> None:
    """Fallback PCA using numpy SVD."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    names = list(type_embeddings.keys())
    vecs = np.array([type_embeddings[n] for n in names], dtype=np.float64)

    # Center
    vecs_c = vecs - vecs.mean(axis=0, keepdims=True)
    # SVD
    U, S, Vt = np.linalg.svd(vecs_c, full_matrices=False)
    coords = vecs_c @ Vt[:2].T  # [5, 2]

    fig, ax = plt.subplots(figsize=(6, 5))
    colors = ["tab:blue", "tab:orange", "tab:green", "tab:red", "tab:purple"]
    for i, (name, (px, py)) in enumerate(zip(names, coords)):
        ax.scatter(px, py, color=colors[i], s=120, zorder=3)
        ax.annotate(name, (px, py), textcoords="offset points", xytext=(6, 4),
                    fontsize=9, color=colors[i])

    ax.set_title("G3: PCA of Learned Type Embedding Vectors (after training)")
    ax.set_xlabel("PC1")
    ax.set_ylabel("PC2")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(str(output_path), dpi=150)
    plt.close(fig)
    print(f"  PCA plot saved to {output_path}")


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"\n=== G3 Typed-Link Gradient Signal Spike ===")
    print(f"  Device:      {device}")
    print(f"  Corpus size: {args.corpus_size:,} nodes")
    print(f"  Steps:       {args.n_steps}")
    print(f"  Seed:        {args.seed}")

    # -------------------------------------------------------------------------
    # 1. Generate synthetic corpus.
    # -------------------------------------------------------------------------
    print("\n[1/5] Generating synthetic corpus...")
    t0 = time.time()
    n_edges = args.corpus_size * 5  # ~5 edges per node
    data = generate_synthetic_graph(
        n_nodes=args.corpus_size,
        n_edges=n_edges,
        seed=args.seed,
    )
    print(f"  Generated {data.n_nodes:,} nodes, {data.n_edges:,} edges in {time.time()-t0:.1f}s")

    node_feat_dim = data.x.shape[1]

    # -------------------------------------------------------------------------
    # 2. Train TypedLinkGraphModel.
    # -------------------------------------------------------------------------
    print(f"\n[2/5] Training TypedLinkGraphModel for {args.n_steps} steps...")
    torch.manual_seed(args.seed)
    typed_model = TypedLinkGraphModel(
        node_feat_dim=node_feat_dim,
        hidden_dim=args.hidden_dim,
        out_dim=args.out_dim,
        type_emb_dim=args.type_emb_dim,
    )
    typed_model = typed_model.to(device)
    typed_model.train()

    x = data.x.to(device)
    edge_index = data.edge_index.to(device)
    edge_type_t = data.edge_type.to(device)
    edge_confidence = data.edge_confidence.to(device)
    pair_index = data.pair_index.to(device)
    pair_labels = data.pair_labels.to(device)

    n_pairs = pair_index.shape[0]
    n_train = int(n_pairs * 0.8)
    train_pairs = pair_index[:n_train]
    train_labels = pair_labels[:n_train]
    val_pairs = pair_index[n_train:]
    val_labels = pair_labels[n_train:]

    optimizer = torch.optim.Adam(typed_model.parameters(), lr=args.lr)
    criterion = torch.nn.BCEWithLogitsLoss()

    typed_loss_curve: list[float] = []
    t1 = time.time()
    for step in range(args.n_steps):
        optimizer.zero_grad()
        node_emb = typed_model(x, edge_index, edge_type_t, edge_confidence)
        logits = typed_model.predict(node_emb, train_pairs)
        loss = criterion(logits, train_labels)
        loss.backward()
        optimizer.step()
        typed_loss_curve.append(float(loss.item()))
        if (step + 1) % max(1, args.n_steps // 5) == 0:
            print(f"  Step {step+1:4d}/{args.n_steps} — loss={loss.item():.4f}")

    typed_model.eval()
    with torch.no_grad():
        val_emb = typed_model(x, edge_index, edge_type_t, edge_confidence)
        val_logits = typed_model.predict(val_emb, val_pairs)
        val_preds = (torch.sigmoid(val_logits) >= 0.5).float()
        typed_accuracy = float((val_preds == val_labels).float().mean().item())
    print(f"  Typed model trained in {time.time()-t1:.1f}s — val accuracy={typed_accuracy:.3f}")

    # -------------------------------------------------------------------------
    # 3. Measure edge type divergence.
    # -------------------------------------------------------------------------
    print("\n[3/5] Measuring edge type divergence...")
    divergence = measure_edge_type_divergence(typed_model, data, device=device)
    p_value = divergence["mannwhitney_p_value"]
    sep_ratio = divergence["separation_ratio"]
    pass_g3 = divergence["pass_g3"]
    print(f"  separation_ratio = {sep_ratio:.3f}")
    print(f"  Mann-Whitney U p = {p_value:.4f}")
    print(f"  G3 PASS: {pass_g3}")

    # -------------------------------------------------------------------------
    # 4. Train UntypedGNNModel for comparison.
    # -------------------------------------------------------------------------
    print(f"\n[4/5] Training UntypedGNNModel for {args.n_steps} steps...")
    comparison = compare_typed_vs_untyped(
        data,
        n_steps=args.n_steps,
        seed=args.seed,
        lr=args.lr,
        device=device,
        node_feat_dim=node_feat_dim,
        hidden_dim=args.hidden_dim,
        out_dim=args.out_dim,
        type_emb_dim=args.type_emb_dim,
        verbose=False,
    )
    print(f"  Typed accuracy:    {comparison['typed_accuracy']:.3f}")
    print(f"  Untyped accuracy:  {comparison['untyped_accuracy']:.3f}")
    print(f"  Typed better:      {comparison['typed_better']}")

    # -------------------------------------------------------------------------
    # 5. Write results JSON.
    # -------------------------------------------------------------------------
    print("\n[5/5] Writing results...")
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if pass_g3:
        interpretation = (
            "Typed links develop distinct gradient profiles. "
            "Link types are a meaningful gradient training axis."
        )
    else:
        interpretation = (
            "Typed links did NOT develop statistically distinct gradient profiles. "
            "Link types carry no independent gradient signal; "
            "model reduces to standard GNN aggregation over untyped edges."
        )

    result = {
        "pass_g3": pass_g3,
        "p_value": p_value,
        "separation_ratio": sep_ratio,
        "typed_accuracy": comparison["typed_accuracy"],
        "untyped_accuracy": comparison["untyped_accuracy"],
        "typed_better": comparison["typed_better"],
        "accuracy_delta": comparison["accuracy_delta"],
        "typed_final_loss": comparison["typed_final_loss"],
        "untyped_final_loss": comparison["untyped_final_loss"],
        "mean_within_type_distance": divergence["mean_within_type_distance"],
        "mean_cross_type_distance": divergence["mean_cross_type_distance"],
        "mannwhitney_statistic": divergence["mannwhitney_statistic"],
        "interpretation": interpretation,
        "config": {
            "n_steps": args.n_steps,
            "corpus_size": args.corpus_size,
            "seed": args.seed,
            "hidden_dim": args.hidden_dim,
            "out_dim": args.out_dim,
            "type_emb_dim": args.type_emb_dim,
            "device": str(device),
        },
    }

    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"  Results written to {output_path}")

    # -------------------------------------------------------------------------
    # 6. Generate PCA visualisation.
    # -------------------------------------------------------------------------
    if not args.no_plot:
        plot_path = output_path.parent / "g3_type_embeddings.png"
        print(f"\n[6/6] Generating PCA plot -> {plot_path}")
        try:
            _generate_pca_plot(divergence["type_embeddings"], plot_path)
        except Exception as exc:
            print(f"  Warning: PCA plot failed: {exc}")

    # -------------------------------------------------------------------------
    # Summary.
    # -------------------------------------------------------------------------
    print("\n" + "=" * 50)
    if pass_g3:
        print("RESULT: G3 PASS — typed link types develop distinct gradient profiles.")
        print(f"        p={p_value:.4f} < 0.05, separation_ratio={sep_ratio:.2f}")
    else:
        print("RESULT: G3 FAIL — typed link types do not show significant separation.")
        print(f"        p={p_value:.4f} >= 0.05, separation_ratio={sep_ratio:.2f}")
        print("        Link types will be dropped from the gradient training axis.")
    print("=" * 50 + "\n")

    return 0 if pass_g3 else 1


if __name__ == "__main__":
    sys.exit(main())
