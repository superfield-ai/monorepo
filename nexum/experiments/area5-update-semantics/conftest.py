"""
conftest.py — pytest configuration for Area 5 tests.

Registers the 'slow' mark and provides the --run-slow CLI option.
Slow tests are skipped by default; run with: pytest --run-slow
"""

from __future__ import annotations

import pytest


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--run-slow",
        action="store_true",
        default=False,
        help="Run slow tests that require sentence-transformers.",
    )


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "slow: marks tests as slow (skip by default; enable with --run-slow)",
    )


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    if not config.getoption("--run-slow"):
        skip_slow = pytest.mark.skip(reason="Use --run-slow to run slow tests")
        for item in items:
            if "slow" in item.keywords:
                item.add_marker(skip_slow)
