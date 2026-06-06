"""
conftest.py — pytest configuration for Area 6 tests.

Adds the experiment root to sys.path so test files can import modules
directly (e.g. `from ann_benchmark import run_ann_benchmark`).

Registers the 'gpu' and 'slow' marks.  GPU tests are skipped by default;
run with: pytest --run-gpu
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure the area6 package root is importable from tests/
sys.path.insert(0, str(Path(__file__).parent))


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--run-gpu",
        action="store_true",
        default=False,
        help="Run tests that require CUDA hardware.",
    )
    parser.addoption(
        "--run-slow",
        action="store_true",
        default=False,
        help="Run slow tests.",
    )


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "gpu: marks tests requiring CUDA hardware (skip by default; enable with --run-gpu)",
    )
    config.addinivalue_line(
        "markers",
        "slow: marks tests as slow (skip by default; enable with --run-slow)",
    )


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    if not config.getoption("--run-gpu"):
        skip_gpu = pytest.mark.skip(reason="Use --run-gpu to run GPU tests")
        for item in items:
            if "gpu" in item.keywords:
                item.add_marker(skip_gpu)

    if not config.getoption("--run-slow"):
        skip_slow = pytest.mark.skip(reason="Use --run-slow to run slow tests")
        for item in items:
            if "slow" in item.keywords:
                item.add_marker(skip_slow)
