"""
runner.py — Shared phase-0 gate benchmark runner (dev-scout stub).

Captures the metadata every gate experiment must record so that gate results
across G0/G1/G4 and the H1.1 Postgres-scale gate are directly comparable:

- Hardware profile: platform, CPU, RAM, accelerator, torch/cuda version when
  available. Heavy deps (`torch`, `psutil`) are imported lazily so this
  module is safe to import in any gate's pyproject environment, including
  CPU-only smoke runs that lack torch.
- Image digest: Docker image / git SHA snapshot of the runtime, for
  artifact provenance.
- Environment vars: a small allowlist of harness-relevant env vars
  (CUDA_VISIBLE_DEVICES, NEXUM_*, PYTHONHASHSEED).
- RNG seed: a single int seed that gate experiments are expected to
  fan out to numpy / torch / python random. Stored verbatim in the
  result envelope so reruns are reproducible.

This is a SCOUT stub — it does not change runtime behaviour of any
existing experiment. Downstream gate issues (#73, #74, #4, #3) will
import `capture_run_context` and embed its dict output under a
`runtime` key in their result JSON via `experiments._lib.results_writer`.

Canonical references:
- docs/research.md
- docs/research/methodology.md (Hardware Profile / RNG Seed conventions)
- docs/research/queue.md
"""

from __future__ import annotations

import os
import platform
import socket
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from typing import Any


# Env vars surfaced into the run context. Kept small and explicit — we do
# not want to inadvertently leak secrets via result JSON.
_ENV_ALLOWLIST: tuple[str, ...] = (
    "CUDA_VISIBLE_DEVICES",
    "PYTHONHASHSEED",
    "NEXUM_GATE",
    "NEXUM_RUN_ID",
    "NEXUM_IMAGE_DIGEST",
)


@dataclass(frozen=True)
class RunContext:
    """
    Frozen snapshot of runtime metadata for a single gate experiment run.

    Gate experiments embed `to_dict()` under the `runtime` key of their
    result envelope (see results_writer.py).
    """

    gate: str
    hypothesis: str
    seed: int
    started_at_unix: float
    started_at_iso: str
    hostname: str
    platform: str
    python_version: str
    cpu: str
    cpu_count: int
    ram_bytes: int | None
    accelerator: dict[str, Any]
    torch_version: str | None
    image_digest: str | None
    git_sha: str | None
    env: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe dict representation."""
        return asdict(self)


def _git_sha() -> str | None:
    """Best-effort short git SHA of the current worktree, or None."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return out.decode().strip() or None
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None


def _accelerator_info() -> tuple[dict[str, Any], str | None]:
    """
    Probe for a torch-visible accelerator without requiring torch.

    Returns (accelerator_dict, torch_version_or_None). When torch is not
    installed (CPU-only smoke envs, or g1-postgres-scale which has no
    torch dep), this returns a `device=cpu` shell so the harness still
    produces a complete envelope.
    """
    try:
        import torch  # type: ignore[import-not-found]
    except Exception:
        return {"device": "cpu", "available": False}, None

    info: dict[str, Any] = {"device": "cpu", "available": True}
    try:
        if torch.cuda.is_available():
            info["device"] = "cuda"
            info["cuda_device_name"] = torch.cuda.get_device_name(0)
            info["cuda_version"] = torch.version.cuda
            info["device_count"] = torch.cuda.device_count()
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            info["device"] = "mps"
    except Exception:
        # Torch import succeeded but probe failed — degrade to cpu.
        info["device"] = "cpu"
        info["probe_error"] = True
    return info, getattr(torch, "__version__", None)


def _ram_bytes() -> int | None:
    """Return total physical RAM in bytes, or None if psutil is unavailable."""
    try:
        import psutil  # type: ignore[import-not-found]

        return int(psutil.virtual_memory().total)
    except Exception:
        return None


def _env_snapshot() -> dict[str, str]:
    """Return values of allowlisted env vars (only those that are set)."""
    return {k: os.environ[k] for k in _ENV_ALLOWLIST if k in os.environ}


def capture_run_context(
    *,
    gate: str,
    hypothesis: str,
    seed: int,
    image_digest: str | None = None,
) -> RunContext:
    """
    Capture a `RunContext` for the calling gate experiment.

    Parameters
    ----------
    gate: short gate identifier (e.g. "G0", "G1", "G4", "H1.1").
    hypothesis: hypothesis ID this run targets (e.g. "H7.1").
    seed: RNG seed used by the experiment. Stored verbatim.
    image_digest: optional Docker image digest. Falls back to
        $NEXUM_IMAGE_DIGEST when not provided.
    """
    accelerator, torch_version = _accelerator_info()
    started = time.time()
    return RunContext(
        gate=gate,
        hypothesis=hypothesis,
        seed=int(seed),
        started_at_unix=started,
        started_at_iso=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
        hostname=socket.gethostname(),
        platform=platform.platform(),
        python_version=sys.version.split()[0],
        cpu=platform.processor() or platform.machine(),
        cpu_count=os.cpu_count() or 0,
        ram_bytes=_ram_bytes(),
        accelerator=accelerator,
        torch_version=torch_version,
        image_digest=image_digest or os.environ.get("NEXUM_IMAGE_DIGEST"),
        git_sha=_git_sha(),
        env=_env_snapshot(),
    )
