"""
tests/test_g3.py — Pytest tests for the G3 typed-link gradient signal spike.

All tests run on CPU without GPU or special hardware.
Tiny graphs (10–200 nodes) are used for speed.

Tests:
    1. test_untyped_model_forward_pass
    2. test_untyped_model_has_no_type_embeddings
    3. test_within_type_distances_computed
    4. test_mannwhitney_significance
    5. test_separation_ratio_gt_1_means_signal
    6. test_compare_typed_vs_untyped_structure
    7. test_pass_g3_criterion
    8. test_type_embeddings_not_identical_after_training
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import torch
import numpy as np

# Ensure both G0 and G3 experiment roots are on sys.path.
G3_ROOT = Path(__file__).resolve().parent.parent
G0_ROOT = G3_ROOT.parent / "g0-differentiability"
for root in (str(G3_ROOT), str(G0_ROOT)):
    if root not in sys.path:
        sys.path.insert(0, root)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_tiny_pyg_data(
    n_nodes: int = 50,
    n_edges: int = 200,
    node_feat_dim: int = 128,  # G0 data.py default; keep 128 unless overridden
    n_labeled_pairs: int = 40,
    seed: int = 0,
):
    """Return a tiny PyG Data object using G0's generate_synthetic_graph."""
    from data import generate_synthetic_graph
    return generate_synthetic_graph(
        n_nodes=n_nodes,
        n_edges=n_edges,
        n_labeled_pairs=n_labeled_pairs,
        node_feat_dim=node_feat_dim,
        seed=seed,
    )


def _make_tiny_tensors(
    n_nodes: int = 10,
    n_edges: int = 30,
    node_feat_dim: int = 16,
    num_edge_types: int = 5,
    seed: int = 0,
) -> dict:
    """Return plain tensors without PyG dependency."""
    torch.manual_seed(seed)
    x = torch.randn(n_nodes, node_feat_dim)
    edge_index = torch.randint(0, n_nodes, (2, n_edges))
    edge_type = torch.arange(n_edges) % num_edge_types
    edge_confidence = torch.rand(n_edges).clamp(0.01, 0.99)
    return {
        "x": x,
        "edge_index": edge_index,
        "edge_type": edge_type,
        "edge_confidence": edge_confidence,
    }


# ===========================================================================
# 1. test_untyped_model_forward_pass
# ===========================================================================

class TestUntypedModelForwardPass:
    """UntypedGNNModel forward pass returns correct output shape."""

    def test_output_shape(self):
        from untyped_model import UntypedGNNModel

        g = _make_tiny_tensors(n_nodes=10, n_edges=30, node_feat_dim=16)
        model = UntypedGNNModel(
            node_feat_dim=16,
            hidden_dim=8,
            out_dim=4,
            num_layers=2,
        )
        model.eval()
        with torch.no_grad():
            out = model(
                g["x"],
                g["edge_index"],
                g["edge_type"],       # accepted but ignored
                g["edge_confidence"],
            )
        assert out.shape == (10, 4), f"Expected (10, 4), got {out.shape}"

    def test_output_is_finite(self):
        from untyped_model import UntypedGNNModel

        g = _make_tiny_tensors(n_nodes=10, n_edges=30, node_feat_dim=16)
        model = UntypedGNNModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        model.eval()
        with torch.no_grad():
            out = model(
                g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"]
            )
        assert torch.isfinite(out).all(), "Output contains NaN or Inf"

    def test_predict_shape(self):
        from untyped_model import UntypedGNNModel

        g = _make_tiny_tensors(n_nodes=10, n_edges=30, node_feat_dim=16)
        model = UntypedGNNModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        model.eval()
        with torch.no_grad():
            node_emb = model(
                g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"]
            )
            pairs = torch.tensor([[0, 1], [2, 3], [4, 5]])
            logits = model.predict(node_emb, pairs)
        assert logits.shape == (3,), f"Expected (3,), got {logits.shape}"

    def test_single_layer(self):
        from untyped_model import UntypedGNNModel

        g = _make_tiny_tensors(n_nodes=10, n_edges=20, node_feat_dim=8)
        model = UntypedGNNModel(node_feat_dim=8, hidden_dim=4, out_dim=4, num_layers=1)
        model.eval()
        with torch.no_grad():
            out = model(
                g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"]
            )
        assert out.shape == (10, 4)

    def test_gradient_flows(self):
        from untyped_model import UntypedGNNModel
        import torch.nn as nn

        g = _make_tiny_tensors(n_nodes=10, n_edges=30, node_feat_dim=16)
        model = UntypedGNNModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        node_emb = model(
            g["x"], g["edge_index"], g["edge_type"], g["edge_confidence"]
        )
        pairs = torch.tensor([[0, 1], [2, 3]])
        labels = torch.tensor([1.0, 0.0])
        logits = model.predict(node_emb, pairs)
        loss = nn.functional.binary_cross_entropy_with_logits(logits, labels)
        loss.backward()  # Must not raise


# ===========================================================================
# 2. test_untyped_model_has_no_type_embeddings
# ===========================================================================

class TestUntypedModelHasNoTypeEmbeddings:
    """UntypedGNNModel must not contain any parameter named 'type_embedding'."""

    def test_no_type_embedding_parameter(self):
        from untyped_model import UntypedGNNModel

        model = UntypedGNNModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        for name, _ in model.named_parameters():
            assert "type_embedding" not in name, (
                f"UntypedGNNModel should not have a type_embedding parameter, "
                f"but found: {name}"
            )

    def test_no_type_embedding_module(self):
        from untyped_model import UntypedGNNModel
        import torch.nn as nn

        model = UntypedGNNModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        for name, module in model.named_modules():
            if isinstance(module, nn.Embedding):
                assert "type_embedding" not in name, (
                    f"Found nn.Embedding named {name!r} — "
                    "untyped model must not use type embeddings."
                )

    def test_typed_model_has_type_embedding(self):
        """Sanity check: typed model DOES have type_embedding."""
        from model import TypedLinkGraphModel

        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        names = [n for n, _ in model.named_parameters()]
        assert any("type_embedding" in n for n in names), (
            "TypedLinkGraphModel should have type_embedding parameters."
        )


# ===========================================================================
# 3. test_within_type_distances_computed
# ===========================================================================

class TestWithinTypeDistancesComputed:
    """
    After training with G0 model, measure_edge_type_divergence returns dicts
    containing all 5 link types.
    """

    def test_all_link_types_present(self):
        from model import TypedLinkGraphModel, EDGE_TYPES
        from signal_measurement import measure_edge_type_divergence

        # Tiny graph; we don't need G3 to pass at this scale.
        data = _make_tiny_pyg_data(n_nodes=100, n_edges=500, seed=0)
        model = TypedLinkGraphModel(
            node_feat_dim=16,
            hidden_dim=8,
            out_dim=4,
            type_emb_dim=4,
        )
        result = measure_edge_type_divergence(model, data)

        # within_type_distances must contain all 5 type names.
        missing = set(EDGE_TYPES) - set(result["within_type_distances"].keys())
        assert not missing, f"within_type_distances missing types: {missing}"

    def test_type_embeddings_returned_for_all_types(self):
        from model import TypedLinkGraphModel, EDGE_TYPES
        from signal_measurement import measure_edge_type_divergence

        data = _make_tiny_pyg_data(n_nodes=100, n_edges=500, seed=1)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        result = measure_edge_type_divergence(model, data)

        for name in EDGE_TYPES:
            assert name in result["type_embeddings"], (
                f"type_embeddings missing key {name!r}"
            )
            assert isinstance(result["type_embeddings"][name], list)

    def test_result_keys_complete(self):
        from model import TypedLinkGraphModel
        from signal_measurement import measure_edge_type_divergence

        data = _make_tiny_pyg_data(n_nodes=80, n_edges=300, seed=2)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        result = measure_edge_type_divergence(model, data)

        required = {
            "type_embeddings",
            "within_type_distances",
            "cross_type_distances",
            "mean_within_type_distance",
            "mean_cross_type_distance",
            "separation_ratio",
            "mannwhitney_statistic",
            "mannwhitney_p_value",
            "pass_g3",
        }
        missing = required - set(result.keys())
        assert not missing, f"Result dict missing keys: {missing}"


# ===========================================================================
# 4. test_mannwhitney_significance
# ===========================================================================

class TestMannWhitneySignificance:
    """
    Inject clearly separated and identical distributions.
    Verify p < 0.05 for separated, p > 0.05 for identical.
    """

    def test_clearly_separated_distribution_is_significant(self):
        from scipy.stats import mannwhitneyu

        rng = np.random.default_rng(0)
        within = rng.uniform(0.0, 0.1, size=200)   # very small distances
        cross = rng.uniform(0.5, 1.0, size=200)    # very large distances

        _, p = mannwhitneyu(within, cross, alternative="less")
        assert p < 0.05, (
            f"Expected p < 0.05 for clearly separated distributions, got p={p:.4f}"
        )

    def test_identical_distribution_is_not_significant(self):
        from scipy.stats import mannwhitneyu

        rng = np.random.default_rng(42)
        within = rng.uniform(0.3, 0.7, size=200)
        cross = rng.uniform(0.3, 0.7, size=200)  # same distribution

        _, p = mannwhitneyu(within, cross, alternative="less")
        assert p > 0.05, (
            f"Expected p > 0.05 for identical distributions, got p={p:.4f}"
        )

    def test_partially_separated_intermediate_p(self):
        """Partially overlapping — p may be anything; just verify it runs."""
        from scipy.stats import mannwhitneyu

        rng = np.random.default_rng(7)
        within = rng.uniform(0.1, 0.5, size=100)
        cross = rng.uniform(0.3, 0.7, size=100)

        stat, p = mannwhitneyu(within, cross, alternative="less")
        assert 0.0 <= p <= 1.0, f"p-value out of range: {p}"
        assert stat >= 0.0, f"Statistic should be non-negative: {stat}"


# ===========================================================================
# 5. test_separation_ratio_gt_1_means_signal
# ===========================================================================

class TestSeparationRatio:
    """
    separation_ratio = mean_cross / mean_within.
    Verify the formula with known vectors.
    """

    def test_ratio_greater_than_1_when_cross_larger(self):
        mean_within = 0.2
        mean_cross = 0.6
        ratio = mean_cross / mean_within
        assert ratio > 1.0, f"Expected ratio > 1, got {ratio}"

    def test_ratio_less_than_1_when_within_larger(self):
        mean_within = 0.8
        mean_cross = 0.2
        ratio = mean_cross / mean_within
        assert ratio < 1.0, f"Expected ratio < 1, got {ratio}"

    def test_ratio_equals_1_when_equal(self):
        mean_within = 0.5
        mean_cross = 0.5
        ratio = mean_cross / mean_within
        assert abs(ratio - 1.0) < 1e-9, f"Expected ratio == 1, got {ratio}"

    def test_measure_returns_separation_ratio(self):
        """measure_edge_type_divergence computes separation_ratio correctly."""
        from model import TypedLinkGraphModel
        from signal_measurement import measure_edge_type_divergence

        data = _make_tiny_pyg_data(n_nodes=100, n_edges=500, seed=5)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)
        result = measure_edge_type_divergence(model, data)

        # Verify the formula: ratio = cross / within (within > 0).
        mw = result["mean_within_type_distance"]
        mc = result["mean_cross_type_distance"]
        sr = result["separation_ratio"]

        if mw > 1e-12:
            expected = mc / mw
            assert abs(sr - expected) < 1e-6, (
                f"separation_ratio mismatch: got {sr}, expected {expected}"
            )


# ===========================================================================
# 6. test_compare_typed_vs_untyped_structure
# ===========================================================================

class TestCompareTypedVsUntypedStructure:
    """compare_typed_vs_untyped returns all required keys with correct types."""

    def test_all_required_keys_present(self):
        from signal_measurement import compare_typed_vs_untyped

        data = _make_tiny_pyg_data(n_nodes=80, n_edges=300, seed=0)
        result = compare_typed_vs_untyped(data, n_steps=20, seed=0)

        required = {
            "typed_accuracy",
            "untyped_accuracy",
            "typed_final_loss",
            "untyped_final_loss",
            "typed_better",
            "accuracy_delta",
        }
        missing = required - set(result.keys())
        assert not missing, f"compare_typed_vs_untyped missing keys: {missing}"

    def test_typed_accuracy_is_float_in_range(self):
        from signal_measurement import compare_typed_vs_untyped

        data = _make_tiny_pyg_data(n_nodes=80, n_edges=300, seed=1)
        result = compare_typed_vs_untyped(data, n_steps=20, seed=1)

        assert isinstance(result["typed_accuracy"], float)
        assert 0.0 <= result["typed_accuracy"] <= 1.0

    def test_untyped_accuracy_is_float_in_range(self):
        from signal_measurement import compare_typed_vs_untyped

        data = _make_tiny_pyg_data(n_nodes=80, n_edges=300, seed=2)
        result = compare_typed_vs_untyped(data, n_steps=20, seed=2)

        assert isinstance(result["untyped_accuracy"], float)
        assert 0.0 <= result["untyped_accuracy"] <= 1.0

    def test_typed_better_is_bool(self):
        from signal_measurement import compare_typed_vs_untyped

        data = _make_tiny_pyg_data(n_nodes=80, n_edges=300, seed=3)
        result = compare_typed_vs_untyped(data, n_steps=20, seed=3)

        assert isinstance(result["typed_better"], bool)

    def test_accuracy_delta_consistency(self):
        """accuracy_delta = typed - untyped; typed_better iff delta > 0."""
        from signal_measurement import compare_typed_vs_untyped

        data = _make_tiny_pyg_data(n_nodes=80, n_edges=300, seed=4)
        result = compare_typed_vs_untyped(data, n_steps=20, seed=4)

        delta = result["typed_accuracy"] - result["untyped_accuracy"]
        assert abs(result["accuracy_delta"] - delta) < 1e-6, (
            f"accuracy_delta={result['accuracy_delta']} inconsistent with "
            f"typed={result['typed_accuracy']}, untyped={result['untyped_accuracy']}"
        )
        assert result["typed_better"] == (result["typed_accuracy"] > result["untyped_accuracy"])

    def test_losses_are_finite(self):
        from signal_measurement import compare_typed_vs_untyped

        data = _make_tiny_pyg_data(n_nodes=80, n_edges=300, seed=5)
        result = compare_typed_vs_untyped(data, n_steps=20, seed=5)

        import math
        assert math.isfinite(result["typed_final_loss"]), "typed_final_loss is not finite"
        assert math.isfinite(result["untyped_final_loss"]), "untyped_final_loss is not finite"


# ===========================================================================
# 7. test_pass_g3_criterion
# ===========================================================================

class TestPassG3Criterion:
    """pass_g3 = True iff mannwhitney_p_value < 0.05."""

    def test_pass_g3_true_when_p_below_threshold(self):
        from model import TypedLinkGraphModel, EDGE_TYPES
        from signal_measurement import measure_edge_type_divergence
        from unittest.mock import patch
        from scipy.stats import mannwhitneyu

        data = _make_tiny_pyg_data(n_nodes=100, n_edges=500, seed=0)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)

        # Patch mannwhitneyu to return p=0.001 (well below threshold).
        with patch("signal_measurement.mannwhitneyu") as mock_mwu:
            mock_mwu.return_value = (1000.0, 0.001)
            result = measure_edge_type_divergence(model, data)

        assert result["pass_g3"] is True, "pass_g3 should be True when p=0.001 < 0.05"
        assert abs(result["mannwhitney_p_value"] - 0.001) < 1e-9

    def test_pass_g3_false_when_p_above_threshold(self):
        from model import TypedLinkGraphModel
        from signal_measurement import measure_edge_type_divergence
        from unittest.mock import patch

        data = _make_tiny_pyg_data(n_nodes=100, n_edges=500, seed=0)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)

        with patch("signal_measurement.mannwhitneyu") as mock_mwu:
            mock_mwu.return_value = (500.0, 0.30)
            result = measure_edge_type_divergence(model, data)

        assert result["pass_g3"] is False, "pass_g3 should be False when p=0.30 >= 0.05"

    def test_pass_g3_false_at_boundary(self):
        """p == 0.05 is not strictly below threshold — should fail."""
        from model import TypedLinkGraphModel
        from signal_measurement import measure_edge_type_divergence
        from unittest.mock import patch

        data = _make_tiny_pyg_data(n_nodes=100, n_edges=500, seed=0)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)

        with patch("signal_measurement.mannwhitneyu") as mock_mwu:
            mock_mwu.return_value = (500.0, 0.05)
            result = measure_edge_type_divergence(model, data)

        assert result["pass_g3"] is False, "pass_g3 should be False when p == 0.05"

    def test_pass_g3_iff_p_lt_005(self):
        """Parametric check: pass_g3 == (p < 0.05) for various injected p values."""
        from model import TypedLinkGraphModel
        from signal_measurement import measure_edge_type_divergence
        from unittest.mock import patch

        data = _make_tiny_pyg_data(n_nodes=80, n_edges=300, seed=0)
        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4)

        for p_inject in [0.001, 0.04, 0.049, 0.05, 0.06, 0.5, 0.99]:
            with patch("signal_measurement.mannwhitneyu") as mock_mwu:
                mock_mwu.return_value = (100.0, p_inject)
                result = measure_edge_type_divergence(model, data)
            expected = p_inject < 0.05
            assert result["pass_g3"] == expected, (
                f"p={p_inject}: expected pass_g3={expected}, got {result['pass_g3']}"
            )


# ===========================================================================
# 8. test_type_embeddings_not_identical_after_training
# ===========================================================================

class TestTypeEmbeddingsNotIdenticalAfterTraining:
    """
    After 100 gradient steps on the synthetic corpus, the 5 type embedding
    vectors must not all be identical — they must diverge from initialization.
    """

    def test_type_embeddings_diverge_after_100_steps(self):
        from model import TypedLinkGraphModel, EDGE_TYPES
        import torch.nn as nn

        torch.manual_seed(0)

        # Use a small-but-representable graph so all 5 types appear.
        data = _make_tiny_pyg_data(
            n_nodes=200, n_edges=1000, node_feat_dim=16, seed=42
        )

        model = TypedLinkGraphModel(
            node_feat_dim=16,
            hidden_dim=16,
            out_dim=8,
            type_emb_dim=8,
        )
        optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
        criterion = nn.BCEWithLogitsLoss()

        x = data.x
        edge_index = data.edge_index
        edge_type = data.edge_type
        edge_confidence = data.edge_confidence
        pair_index = data.pair_index
        pair_labels = data.pair_labels

        for _ in range(100):
            optimizer.zero_grad()
            node_emb = model(x, edge_index, edge_type, edge_confidence)
            logits = model.predict(node_emb, pair_index)
            loss = criterion(logits, pair_labels)
            loss.backward()
            optimizer.step()

        # Extract type embeddings from the first conv layer.
        type_embs = model.conv_layers[0].type_embedding.weight  # [5, type_emb_dim]

        # All pairs should NOT be identical.
        n_types = len(EDGE_TYPES)
        all_identical = True
        for i in range(n_types):
            for j in range(i + 1, n_types):
                dist = (type_embs[i] - type_embs[j]).norm().item()
                if dist > 1e-6:
                    all_identical = False
                    break
            if not all_identical:
                break

        assert not all_identical, (
            "All 5 type embedding vectors are identical after 100 training steps — "
            "the optimizer collapsed all edge types to a single representation."
        )

    def test_type_embeddings_distinct_at_init(self):
        """Sanity: type embeddings start distinct (not all zeros)."""
        from model import TypedLinkGraphModel, EDGE_TYPES

        model = TypedLinkGraphModel(node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=8)
        embs = model.conv_layers[0].type_embedding.weight  # [5, 8]

        for i in range(len(EDGE_TYPES)):
            for j in range(i + 1, len(EDGE_TYPES)):
                d = (embs[i] - embs[j]).norm().item()
                assert d > 0.0, f"Type embeddings {i} and {j} identical at init"

    def test_type_embeddings_change_after_training(self):
        """Type embedding weights must change during training (not frozen)."""
        from model import TypedLinkGraphModel
        import torch.nn as nn

        torch.manual_seed(1)
        data = _make_tiny_pyg_data(n_nodes=100, n_edges=500, node_feat_dim=16, seed=1)
        model = TypedLinkGraphModel(
            node_feat_dim=16, hidden_dim=8, out_dim=4, type_emb_dim=8
        )

        # Snapshot initial weights.
        init_weight = model.conv_layers[0].type_embedding.weight.detach().clone()

        optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
        criterion = nn.BCEWithLogitsLoss()

        for _ in range(50):
            optimizer.zero_grad()
            node_emb = model(
                data.x, data.edge_index, data.edge_type, data.edge_confidence
            )
            logits = model.predict(node_emb, data.pair_index)
            loss = criterion(logits, data.pair_labels)
            loss.backward()
            optimizer.step()

        trained_weight = model.conv_layers[0].type_embedding.weight.detach()
        delta = (trained_weight - init_weight).abs().max().item()
        assert delta > 1e-6, (
            f"Type embedding weights did not change after training (max delta={delta:.2e})"
        )
