"""
results_writer.py — Canonical result envelope writer for phase-0 gates.

All four phase-0 gate experiments (#73 G0, #74 G1, #4 H1.1, #3 G4) write
their JSON results through this module so the orchestrator's
`scripts/update-hypothesis-status.sh` and downstream meta-analyses can
parse a single shape.

Envelope shape (top-level keys, fixed):

    {
      "gate":        "G0" | "G1" | "G4" | "H1.1" | ...,
      "hypothesis":  "H7.1",
      "pass":        bool,                # gate-level pass/fail
      "metrics":     { ... gate-specific ... },
      "runtime":     <RunContext.to_dict()>,
      "results_path": "experiments/<area>/results/<gate>_<ts>.json",
      "schema_version": 1
    }

The existing `experiments/g4-onnx-lossless/results/g4_result.json`
artifact uses a similar shape; it remains parseable because this writer
does not delete or rename existing files — it appends new ones using a
timestamped filename.

This is a SCOUT stub. Behaviour: writes a JSON file, returns the dict.
No side effects beyond filesystem write.

Canonical references:
- docs/research.md
- docs/research/methodology.md (Results Envelope section)
- docs/research/queue.md
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from experiments._lib.runner import RunContext


SCHEMA_VERSION = 1


@dataclass
class ResultEnvelope:
    """
    Canonical phase-0 gate result envelope.

    Construct one per gate run, then call `.write(area_dir)` to emit
    `experiments/<area>/results/<gate>_<timestamp>.json`.
    """

    gate: str
    hypothesis: str
    passed: bool
    metrics: dict[str, Any]
    runtime: RunContext
    notes: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self, results_path: str | None = None) -> dict[str, Any]:
        """Serialize to the canonical JSON-safe dict shape."""
        d: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "gate": self.gate,
            "hypothesis": self.hypothesis,
            "pass": bool(self.passed),
            "metrics": self.metrics,
            "runtime": self.runtime.to_dict(),
        }
        if results_path is not None:
            d["results_path"] = results_path
        if self.notes:
            d["notes"] = self.notes
        if self.extra:
            d["extra"] = self.extra
        return d


def _timestamp_slug(epoch: float | None = None) -> str:
    """UTC timestamp slug suitable for filenames: 20260507T123456Z."""
    t = time.gmtime(epoch if epoch is not None else time.time())
    return time.strftime("%Y%m%dT%H%M%SZ", t)


def write_result(
    envelope: ResultEnvelope,
    area_dir: str | os.PathLike[str],
    *,
    timestamp: float | None = None,
    filename: str | None = None,
) -> Path:
    """
    Write `envelope` as JSON under `<area_dir>/results/`.

    Parameters
    ----------
    envelope: populated ResultEnvelope.
    area_dir: experiment directory, e.g. "experiments/g0-differentiability".
    timestamp: optional epoch to use for the filename slug (test hook).
    filename: optional explicit filename (overrides timestamp slug).

    Returns the Path of the written file.
    """
    area = Path(area_dir)
    results_dir = area / "results"
    results_dir.mkdir(parents=True, exist_ok=True)

    if filename is None:
        slug = _timestamp_slug(timestamp)
        filename = f"{envelope.gate.lower()}_{slug}.json"

    out = results_dir / filename
    rel = str(out.as_posix())
    payload = envelope.to_dict(results_path=rel)
    out.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return out
