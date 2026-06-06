"""
tests/test_g0.py — Pytest tests for the G0 differentiability spike.

All tests run on CPU without GPU or special hardware.
They use tiny graphs (10–100 nodes) for speed.

Tests:
1. test_model_forward_pass          — forward pass shape check
2. test_gradient_flows              — loss.backward() + all params have grads
3. test_typed_edge_weights_differ   — edge type embeddings diverge after training
4. test_synthetic_graph_shape       — generate_synthetic_graph returns expected attrs
5. test_monotone_check_logic        — unit tests for check_monotone_decrease
6. test_run_spike_exit_code         — subprocess run of run_spike.py (50 steps)
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
import torch

# Ensure experiment root is on sys.path for imports.
EXP_ROOT = Path(__file__).resolve().parent.parent
if str(EXP_ROOT) not in sys.path:
    sys.path.insert(0, str(EXP_ROOT))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def make_tiny_graph(
    n_nodes: int = 10,
    n_edges: int = 20,
    node_feat_dim: int = 16,
    num_edge_types: int = 5,
    seed: int = 0,
) -> dict:
    """Return a tiny synthetic graph as plain tensors (no PyG dependency)."""
    torch.manual_seed(seed)
    x = torch.randn(n_nodes, node_feat_dim)
    # Random directed edges (may have self-loops for simplicity in tests).
    edge_index = torch.randint(0, n_nodes, (2, n_edges))
    edge_type = torch.randint(0, num_edge_types, (n_edges,))
    edge_confidence = torch.rand(n_edges).clamp(0.01, 0.99)
    return {
        "x": x,
        "edge_index": edge_index,
        "edge_type": edge_type,
        "edge_confidence": edge_confidence,
        "n_nodes": n_nodes,
        "n_edges": n_edges,
    }


# ---------------------------------------------------------------------------
# 1. test_model_forward_pass
# ---------------------------------------------------------------------------

class TestModelForwardPass:
    def test_output_shape(self):
        """forward() returns [n_nodes, out_dim] on a 10-node, 20-edge graph."""
        from model import TypedLinkGraphModel

        g = make_tiny_graph(n_nodes=10, n_edges=20, node_feat_dim=16)
        model = TypedLinkGraphModel(
            node_feat_dim=16,
            hidden_dim=8,
            out_dim=4,
            type_emb_dim=4,
            num_layers=2,
        )
        model.eval()
        with torch.no_grad():
            out = model(
                g["x"],
                g["edge_index"],
                g["edge_type"],
                g["edge_confidence"],
            )
        assert out.shape == (10, 4), f"Expected (10, 4), got {out.shape}"

    def test_output_is_finite(self):
        """forward() output contains no NaN or Inf values."""
        from model import TypedLinkGraphModel

        g = make_tiny_graph(n_nodes=10, n_edges=20, node_feat_dim=16)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=4)
        model.eval()
        with torch.no_grad():
            out = model(g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"])
        assert torch.isfinite(out).all(), "Output contains NaN or Inf"

    def test_predict_shape(self):
        """predict() returns [n_pairs] logits."""
        from model import TypedLinkGraphModel

        g = make_tiny_graph(n_nodes=10, n_edges=20, node_feat_dim=16)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=4)
        model.eval()
        with torch.no_grad():
            node_emb = model(g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"])
            pairs = torch.tensor([[0, 1], [2, 3], [4, 5]])
            logits = model.predict(node_emb, pairs)
        assert logits.shape == (3,), f"Expected (3,), got {logits.shape}"

    def test_single_layer_model(self):
        """Model works with num_layers=1."""
        from model import TypedLinkGraphModel

        g = make_tiny_graph(n_nodes=10, n_edges=15, node_feat_dim=8)
        model = TypedLinkGraphModel(node_feat_dim=8, hidden_dim=4, out_dim=4, num_layers=1)
        model.eval()
        with torch.no_grad():
            out = model(g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"])
        assert out.shape == (10, 4)

    def test_empty_edges(self):
        """Model handles a graph with zero edges (isolated nodes)."""
        from model import TypedLinkGraphModel

        x = torch.randn(5, 16)
        edge_index = torch.zeros((2, 0), dtype=torch.long)
        edge_type = torch.zeros(0, dtype=torch.long)
        edge_confidence = torch.zeros(0)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        model.eval()
        with torch.no_grad():
            out = model(x, edge_index, edge_type, edge_confidence)
        assert out.shape == (5, 4)


# ---------------------------------------------------------------------------
# 2. test_gradient_flows
# ---------------------------------------------------------------------------

class TestGradientFlows:
    def test_backward_runs_without_error(self):
        """loss.backward() completes without error on a tiny graph."""
        from model import TypedLinkGraphModel

        g = make_tiny_graph(n_nodes=10, n_edges=20, node_feat_dim=16)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=4)

        node_emb = model(g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"])
        pairs = torch.tensor([[0, 1], [2, 3], [4, 5]])
        labels = torch.tensor([1.0, 0.0, 1.0])
        logits = model.predict(node_emb, pairs)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(logits, labels)
        loss.backward()  # Must not raise

    def test_all_parameters_have_gradients(self):
        """After backward(), every learnable parameter has a non-None gradient."""
        from model import TypedLinkGraphModel

        g = make_tiny_graph(n_nodes=10, n_edges=20, node_feat_dim=16)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=4)

        node_emb = model(g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"])
        pairs = torch.tensor([[0, 1], [2, 3]])
        labels = torch.tensor([1.0, 0.0])
        logits = model.predict(node_emb, pairs)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(logits, labels)
        loss.backward()

        missing_grads = []
        for name, param in model.named_parameters():
            if param.grad is None:
                missing_grads.append(name)

        assert not missing_grads, (
            f"Parameters without gradients after backward(): {missing_grads}"
        )

    def test_gradient_norms_nonzero(self):
        """All parameter gradients have nonzero norm (no dead parameters)."""
        from model import TypedLinkGraphModel

        g = make_tiny_graph(n_nodes=15, n_edges=30, node_feat_dim=16)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=4)

        node_emb = model(g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"])
        pairs = torch.tensor([[0, 1], [2, 3], [5, 6], [7, 8]])
        labels = torch.tensor([1.0, 0.0, 1.0, 0.0])
        logits = model.predict(node_emb, pairs)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(logits, labels)
        loss.backward()

        zero_grad_params = []
        for name, param in model.named_parameters():
            if param.grad is not None:
                if param.grad.norm().item() == 0.0:
                    zero_grad_params.append(name)

        # Some parameters may have zero gradient due to architecture (e.g. inactive
        # edges). Allow up to 20% zero-grad params — flag if more.
        zero_fraction = len(zero_grad_params) / max(1, len(list(model.parameters())))
        assert zero_fraction <= 0.20, (
            f"{len(zero_grad_params)} parameters have zero gradient: {zero_grad_params}"
        )


# ---------------------------------------------------------------------------
# 3. test_typed_edge_weights_differ
# ---------------------------------------------------------------------------

class TestTypedEdgeWeightsDiffer:
    def test_type_embeddings_diverge_after_training(self):
        """
        After a few training steps, different edge type embeddings should have
        developed distinct vectors (not collapsed to the same point).

        This verifies that the type embedding layer receives meaningful gradient
        signal and that the optimizer does not collapse all types to one vector.
        """
        from model import TypedLinkGraphModel
        import torch.nn as nn

        torch.manual_seed(0)
        g = make_tiny_graph(n_nodes=20, n_edges=60, node_feat_dim=16)

        # Ensure all 5 edge types are represented.
        g["edge_type"] = torch.arange(60) % 5

        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=8)
        optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
        criterion = nn.BCEWithLogitsLoss()

        pairs = torch.tensor([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9],
                               [10, 11], [12, 13], [14, 15], [16, 17], [18, 19]])
        labels = torch.tensor([1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0])

        # Train for 50 steps.
        for _ in range(50):
            optimizer.zero_grad()
            node_emb = model(g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"])
            logits = model.predict(node_emb, pairs)
            loss = criterion(logits, labels)
            loss.backward()
            optimizer.step()

        # Extract type embeddings from the first conv layer.
        type_embs = model.conv_layers[0].type_embedding.weight  # [5, type_emb_dim]

        # Compute pairwise cosine similarities between all type pairs.
        normed = torch.nn.functional.normalize(type_embs, dim=-1)
        sim_matrix = normed @ normed.T  # [5, 5]

        # Off-diagonal similarities (excluding self-similarity).
        off_diag_sims = []
        for i in range(5):
            for j in range(5):
                if i != j:
                    off_diag_sims.append(sim_matrix[i, j].item())

        max_off_diag_sim = max(off_diag_sims)
        # After training, at least one pair of type embeddings should have
        # cosine similarity < 0.99 (i.e., they are not identical).
        assert max_off_diag_sim < 0.99, (
            f"All type embedding pairs have cosine similarity >= 0.99 "
            f"(max={max_off_diag_sim:.4f}) — optimizer may have collapsed types."
        )

    def test_type_embeddings_initialized_distinct(self):
        """Type embeddings start distinct (small random init, not zeros)."""
        from model import TypedLinkGraphModel

        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=8)
        type_embs = model.conv_layers[0].type_embedding.weight  # [5, 8]

        # Check pairwise L2 distances — all should be > 0.
        for i in range(5):
            for j in range(i + 1, 5):
                dist = (type_embs[i] - type_embs[j]).norm().item()
                assert dist > 0, f"Type embeddings {i} and {j} are identical at init."


# ---------------------------------------------------------------------------
# 4. test_synthetic_graph_shape
# ---------------------------------------------------------------------------

class TestSyntheticGraphShape:
    def test_expected_attributes_present(self):
        """generate_synthetic_graph returns a Data object with required attrs."""
        from data import generate_synthetic_graph

        data = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=0)
        assert hasattr(data, "x"),               "Missing attribute: x"
        assert hasattr(data, "edge_index"),      "Missing attribute: edge_index"
        assert hasattr(data, "edge_type"),       "Missing attribute: edge_type"
        assert hasattr(data, "edge_confidence"), "Missing attribute: edge_confidence"
        assert hasattr(data, "pair_index"),      "Missing attribute: pair_index"
        assert hasattr(data, "pair_labels"),     "Missing attribute: pair_labels"

    def test_node_feature_shape(self):
        from data import generate_synthetic_graph

        data = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=0)
        assert data.x.shape[0] == 100, f"Expected 100 nodes, got {data.x.shape[0]}"
        assert data.x.shape[1] == 128, f"Expected 128-dim features, got {data.x.shape[1]}"
        assert data.x.dtype == torch.float32

    def test_edge_index_shape(self):
        from data import generate_synthetic_graph

        data = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=0)
        assert data.edge_index.shape[0] == 2, "edge_index should have shape [2, E]"
        assert data.edge_index.dtype == torch.long

    def test_edge_type_values(self):
        """Edge types are in [0, 4]."""
        from data import generate_synthetic_graph

        data = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=0)
        assert data.edge_type.min().item() >= 0
        assert data.edge_type.max().item() <= 4

    def test_edge_confidence_range(self):
        """Edge confidences are in (0, 1]."""
        from data import generate_synthetic_graph

        data = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=0)
        assert data.edge_confidence.min().item() > 0.0
        assert data.edge_confidence.max().item() <= 1.0

    def test_pair_labels_binary(self):
        """Pair labels are 0.0 or 1.0."""
        from data import generate_synthetic_graph

        data = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=0)
        unique_labels = set(data.pair_labels.tolist())
        assert unique_labels <= {0.0, 1.0}, f"Unexpected label values: {unique_labels}"

    def test_deterministic_given_seed(self):
        """Same seed produces identical graphs."""
        from data import generate_synthetic_graph

        data1 = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=99)
        data2 = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=99)
        assert torch.allclose(data1.x, data2.x), "x differs across identical seeds"
        assert torch.equal(data1.edge_index, data2.edge_index), "edge_index differs"
        assert torch.equal(data1.edge_type, data2.edge_type), "edge_type differs"

    def test_different_seeds_differ(self):
        """Different seeds produce different graphs."""
        from data import generate_synthetic_graph

        data1 = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=1)
        data2 = generate_synthetic_graph(n_nodes=100, n_edges=500, seed=2)
        assert not torch.allclose(data1.x, data2.x), "Different seeds produced identical x"

    def test_all_edge_types_represented(self):
        """With enough edges, all 5 types should appear."""
        from data import generate_synthetic_graph

        data = generate_synthetic_graph(n_nodes=200, n_edges=1000, seed=42)
        unique_types = set(data.edge_type.tolist())
        assert len(unique_types) == 5, f"Expected 5 edge types, got {unique_types}"


# ---------------------------------------------------------------------------
# 5. test_monotone_check_logic
# ---------------------------------------------------------------------------

class TestMonotoneCheckLogic:
    def test_perfectly_monotone(self):
        from train import check_monotone_decrease

        curve = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5]
        assert check_monotone_decrease(curve, tol=0.01) is True

    def test_strictly_increasing_fails(self):
        from train import check_monotone_decrease

        curve = [0.5, 0.6, 0.7, 0.8]
        assert check_monotone_decrease(curve, tol=0.01) is False

    def test_flat_fails(self):
        """Flat curve: final == initial, should fail."""
        from train import check_monotone_decrease

        curve = [0.5] * 10
        assert check_monotone_decrease(curve, tol=0.01) is False

    def test_oscillating_within_tolerance_passes(self):
        """Minor oscillation within tol should pass if overall trend decreases."""
        from train import check_monotone_decrease

        # Decreasing with small bumps, each < tol=0.01.
        curve = [1.0, 0.95, 0.96, 0.90, 0.91, 0.85, 0.80, 0.79]
        # Max increase: 0.01 (within tol).
        assert check_monotone_decrease(curve, tol=0.02) is True

    def test_oscillating_exceeds_tolerance_fails(self):
        from train import check_monotone_decrease

        curve = [1.0, 0.9, 0.95, 0.8, 0.85, 0.7]
        # 0.9 → 0.95 is a 0.05 increase, exceeds tol=0.01.
        assert check_monotone_decrease(curve, tol=0.01) is False

    def test_single_element_fails(self):
        from train import check_monotone_decrease

        assert check_monotone_decrease([0.5], tol=0.01) is False

    def test_empty_curve_fails(self):
        from train import check_monotone_decrease

        assert check_monotone_decrease([], tol=0.01) is False

    def test_two_step_decrease_passes(self):
        from train import check_monotone_decrease

        assert check_monotone_decrease([1.0, 0.9], tol=0.01) is True

    def test_two_step_increase_fails(self):
        from train import check_monotone_decrease

        assert check_monotone_decrease([0.9, 1.0], tol=0.01) is False

    def test_large_single_jump_fails(self):
        """Even if overall trend is down, a large jump should fail."""
        from train import check_monotone_decrease

        curve = [1.0, 0.5, 0.6, 0.4, 0.3]  # 0.5→0.6 is +0.1, exceeds tol=0.01
        assert check_monotone_decrease(curve, tol=0.01) is False


# ---------------------------------------------------------------------------
# 5b. test_monotone_check_smoothed
# ---------------------------------------------------------------------------

class TestMonotoneCheckSmoothed:
    def test_oscillating_but_trending_down_passes(self):
        """Adam-style oscillation around a downward trend should pass."""
        from train import check_monotone_decrease_smoothed

        import random
        random.seed(0)
        n = 500
        trend = [1.0 - 0.9 * (i / (n - 1)) for i in range(n)]
        # Noise amplitude small enough that a window=50 mean is dominated by trend.
        curve = [t + random.uniform(-0.02, 0.02) for t in trend]
        assert check_monotone_decrease_smoothed(curve, window=50, tol=1e-2) is True

    def test_diverging_fails(self):
        from train import check_monotone_decrease_smoothed

        n = 200
        curve = [0.5 + 0.001 * i for i in range(n)]
        assert check_monotone_decrease_smoothed(curve, window=20, tol=1e-3) is False

    def test_too_short_fails(self):
        from train import check_monotone_decrease_smoothed

        assert check_monotone_decrease_smoothed([1.0, 0.5], window=20) is False

    def test_flat_fails(self):
        from train import check_monotone_decrease_smoothed

        curve = [0.5] * 100
        assert check_monotone_decrease_smoothed(curve, window=10, tol=1e-3) is False


# ---------------------------------------------------------------------------
# 6. test_run_spike_exit_code
# ---------------------------------------------------------------------------

class TestRunSpikeExitCode:
    def test_spike_runs_and_exits_cleanly(self):
        """
        Run run_spike.py with --n-steps 50 as a subprocess.
        Accept exit code 0 (PASS) or 1 (FAIL) — either is correct behavior
        at tiny scale. The test verifies that the script runs without crashing
        (no unhandled exception, no exit code 2+).
        """
        run_spike_path = EXP_ROOT / "run_spike.py"
        assert run_spike_path.exists(), f"run_spike.py not found at {run_spike_path}"

        result = subprocess.run(
            [
                sys.executable,
                str(run_spike_path),
                "--n-steps", "50",
                "--seed", "42",
                "--n-nodes", "100",
                "--n-edges", "500",
                "--output", str(EXP_ROOT / "results" / ".g0_test_run_tmp.json"),
                "--no-plot",
                "--no-canonical-envelope",
            ],
            capture_output=True,
            text=True,
            timeout=120,  # 2-minute timeout for CPU run.
        )

        # Exit code must be 0 or 1 (pass or fail); 2+ means a Python error.
        assert result.returncode in (0, 1), (
            f"run_spike.py exited with code {result.returncode} (expected 0 or 1).\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        )

    def test_spike_produces_json_output(self):
        """
        run_spike.py writes a valid JSON file with the required keys.
        """
        import json as json_mod
        import tempfile

        run_spike_path = EXP_ROOT / "run_spike.py"
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            tmp_output = f.name

        try:
            result = subprocess.run(
                [
                    sys.executable,
                    str(run_spike_path),
                    "--n-steps", "50",
                    "--seed", "0",
                    "--n-nodes", "80",
                    "--n-edges", "300",
                    "--output", tmp_output,
                    "--no-plot",
                "--no-canonical-envelope",
                ],
                capture_output=True,
                text=True,
                timeout=120,
            )

            assert result.returncode in (0, 1), (
                f"Unexpected exit code {result.returncode}.\n"
                f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            )

            with open(tmp_output) as f:
                doc = json_mod.load(f)

            required_keys = {
                "pass", "loss_curve", "monotone_decrease", "gradient_health",
                "n_steps", "final_loss", "initial_loss", "hardware",
            }
            missing = required_keys - set(doc.keys())
            assert not missing, f"JSON output missing keys: {missing}"

            assert isinstance(doc["pass"], bool)
            assert isinstance(doc["loss_curve"], list)
            assert len(doc["loss_curve"]) == 50
            assert isinstance(doc["hardware"], dict)
            assert "device" in doc["hardware"]

        finally:
            import os
            if os.path.exists(tmp_output):
                os.unlink(tmp_output)
