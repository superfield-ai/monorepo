"""
experiments/_lib — Shared phase-0 gate verification harness (dev-scout stub).

This package is the shared seam used by the four phase-0 gate experiments
(#73, #74, #4, #3) to write reproducible, comparable result artifacts:

    runner.py         — capture hardware profile, image digest, env vars, RNG seed
    results_writer.py — emit canonical experiments/<area>/results/<gate>_<ts>.json

Canonical references:
- docs/research.md                 — research program overview
- docs/research/methodology.md     — harness conventions (hardware profile,
                                     RNG seed, results JSON shape)
- docs/research/queue.md           — phase ordering and gate dependencies

This is a SCOUT stub only. Real gate logic lives in the gate experiment
modules; this package provides the shared structural seam so that follow-up
gate experiments (G0/G1/G4 and the H1.1 Postgres scale gate) emit
artifacts in a single canonical format.
"""

from experiments._lib.runner import RunContext, capture_run_context
from experiments._lib.results_writer import ResultEnvelope, write_result

__all__ = [
    "RunContext",
    "capture_run_context",
    "ResultEnvelope",
    "write_result",
]
