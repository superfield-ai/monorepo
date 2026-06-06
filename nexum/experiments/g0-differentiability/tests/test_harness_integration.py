"""
test_harness_integration.py — Verify G0 can import the shared phase-0
verification harness scouted in #77.

This is a SCOUT integration check: G0's real gate logic (#73) will
populate `metrics={...}` from the actual training run. For now we only
assert the import surface is reachable and a smoke envelope serializes.

Canonical references:
- docs/research.md
- docs/research/methodology.md (Phase-0 Gate Verification Harness)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def test_g0_can_import_shared_harness(tmp_path):
    from experiments._lib import (
        ResultEnvelope,
        capture_run_context,
        write_result,
    )

    ctx = capture_run_context(gate="G0", hypothesis="H7.1", seed=42)
    env = ResultEnvelope(
        gate="G0",
        hypothesis="H7.1",
        passed=True,
        metrics={"smoke": True},
        runtime=ctx,
    )
    out = write_result(env, tmp_path, filename="g0_smoke.json")
    payload = json.loads(out.read_text())
    assert payload["gate"] == "G0"
    assert payload["runtime"]["seed"] == 42
