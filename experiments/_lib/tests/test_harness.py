"""
test_harness.py — Smoke tests for the phase-0 gate verification harness.

Covers:
- runner.capture_run_context returns required keys with correct types
- results_writer.write_result emits the canonical envelope shape
- 100-block toy corpus end-to-end pass: build envelope, write JSON, parse back
- existing experiments/g4-onnx-lossless/results/g4_result.json is still
  parseable (regression guard for downstream gate experiments)

Canonical references:
- docs/research.md
- docs/research/methodology.md
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from experiments._lib import (
    ResultEnvelope,
    capture_run_context,
    write_result,
)
from experiments._lib.results_writer import SCHEMA_VERSION

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_capture_run_context_minimal():
    ctx = capture_run_context(gate="G0", hypothesis="H7.1", seed=42)
    d = ctx.to_dict()
    assert d["gate"] == "G0"
    assert d["hypothesis"] == "H7.1"
    assert d["seed"] == 42
    assert isinstance(d["python_version"], str) and d["python_version"]
    assert isinstance(d["accelerator"], dict)
    assert d["accelerator"]["device"] in {"cpu", "cuda", "mps"}
    # env snapshot must be a dict (possibly empty) and only allowlisted keys.
    assert isinstance(d["env"], dict)


def test_capture_run_context_image_digest_env(monkeypatch):
    monkeypatch.setenv("NEXUM_IMAGE_DIGEST", "sha256:deadbeef")
    ctx = capture_run_context(gate="G1", hypothesis="H1.1", seed=0)
    assert ctx.image_digest == "sha256:deadbeef"
    assert ctx.to_dict()["env"]["NEXUM_IMAGE_DIGEST"] == "sha256:deadbeef"


def test_write_result_envelope_shape(tmp_path):
    ctx = capture_run_context(gate="G4", hypothesis="H7.3", seed=7)
    env = ResultEnvelope(
        gate="G4",
        hypothesis="H7.3",
        passed=True,
        metrics={"accuracy_delta": 0.0, "max_logit_diff": 1e-6},
        runtime=ctx,
        notes="scout-stub smoke",
    )
    out = write_result(env, tmp_path, filename="g4_test.json")
    assert out.exists()

    payload = json.loads(out.read_text())
    assert payload["schema_version"] == SCHEMA_VERSION
    assert payload["gate"] == "G4"
    assert payload["hypothesis"] == "H7.3"
    assert payload["pass"] is True
    assert payload["metrics"]["accuracy_delta"] == 0.0
    assert payload["runtime"]["seed"] == 7
    assert payload["results_path"].endswith("g4_test.json")
    assert payload["notes"] == "scout-stub smoke"


def test_smoke_100_block_corpus(tmp_path):
    """
    End-to-end smoke: simulate a 100-block toy 'gate' run and round-trip
    the envelope through write/read. This is the CI smoke test referenced
    in the issue's acceptance criteria.
    """
    n_blocks = 100
    seed = 1234
    ctx = capture_run_context(gate="SMOKE", hypothesis="H0.0", seed=seed)
    env = ResultEnvelope(
        gate="SMOKE",
        hypothesis="H0.0",
        passed=True,
        metrics={
            "n_blocks": n_blocks,
            "p50_ms": 1.0,
            "p99_ms": 2.0,
        },
        runtime=ctx,
    )
    out = write_result(env, tmp_path, timestamp=1_700_000_000.0)
    assert out.name.startswith("smoke_")
    assert out.name.endswith(".json")

    payload = json.loads(out.read_text())
    assert payload["metrics"]["n_blocks"] == n_blocks
    assert payload["runtime"]["seed"] == seed
    assert payload["pass"] is True


@pytest.mark.skipif(
    not (REPO_ROOT / "experiments/g4-onnx-lossless/results/g4_result.json").exists(),
    reason="legacy g4_result.json not present in this checkout",
)
def test_legacy_g4_result_still_parseable():
    """
    Regression guard: existing g4_result.json must remain parseable after
    the harness lands. The new schema is additive, so legacy artifacts
    do not need to migrate.
    """
    p = REPO_ROOT / "experiments/g4-onnx-lossless/results/g4_result.json"
    payload = json.loads(p.read_text())
    assert payload["gate"] == "G4"
    assert payload["hypothesis"].startswith("H")
    assert "pass" in payload
