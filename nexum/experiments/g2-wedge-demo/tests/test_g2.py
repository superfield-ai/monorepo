"""
Tests for the G2 wedge demo.

All tests run without live services (no Nexum, no Anthropic API).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Make the demo package importable from this test module regardless of how
# pytest is invoked.
_DEMO_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(_DEMO_DIR))

from attribution_eval import attribution_f1


# ---------------------------------------------------------------------------
# 1. Attribution F1 — perfect match
# ---------------------------------------------------------------------------


def test_attribution_f1_perfect():
    """All cited blocks contain the gold span AND come from the correct doc."""
    gold_span = "governed by the laws of Delaware"
    gold_doc_id = "contract-001"

    citations = [
        {"text": "This agreement is governed by the laws of Delaware.", "doc_id": "contract-001", "score": 0.9},
        {"text": "governed by the laws of Delaware applies here.", "doc_id": "contract-001", "score": 0.8},
    ]

    result = attribution_f1(citations, gold_span, gold_doc_id)

    assert result["precision"] == 1.0
    assert result["recall"] == 1.0
    assert result["f1"] == 1.0
    assert result["false_attribution_rate"] == 0.0


# ---------------------------------------------------------------------------
# 2. Attribution F1 — complete miss
# ---------------------------------------------------------------------------


def test_attribution_f1_miss():
    """No citation contains the gold span, and none is from the correct doc."""
    gold_span = "governed by the laws of Delaware"
    gold_doc_id = "contract-001"

    citations = [
        {"text": "The parties agree to arbitration in New York.", "doc_id": "contract-999", "score": 0.5},
        {"text": "Termination requires 30 days notice.", "doc_id": "contract-888", "score": 0.4},
    ]

    result = attribution_f1(citations, gold_span, gold_doc_id)

    assert result["precision"] == 0.0
    assert result["recall"] == 0.0
    assert result["f1"] == 0.0
    assert result["false_attribution_rate"] == 1.0


# ---------------------------------------------------------------------------
# 3. Attribution F1 — partial match (2 of 5 correct)
# ---------------------------------------------------------------------------


def test_attribution_f1_partial():
    """2 of 5 cited blocks contain the gold span → precision = 0.4."""
    gold_span = "thirty (30) days written notice"
    gold_doc_id = "contract-042"

    citations = [
        {"text": "Either party may terminate with thirty (30) days written notice.", "doc_id": "contract-042", "score": 0.9},
        {"text": "thirty (30) days written notice is required for cancellation.", "doc_id": "contract-042", "score": 0.85},
        {"text": "All disputes shall be resolved by binding arbitration.", "doc_id": "contract-042", "score": 0.6},
        {"text": "The governing law is California.", "doc_id": "contract-999", "score": 0.5},
        {"text": "Intellectual property remains with the licensor.", "doc_id": "contract-042", "score": 0.4},
    ]

    result = attribution_f1(citations, gold_span, gold_doc_id)

    assert result["n_cited"] == 5
    assert result["n_correct"] == 2
    assert abs(result["precision"] - 0.4) < 1e-6


# ---------------------------------------------------------------------------
# 4. False attribution rate = 1 - precision
# ---------------------------------------------------------------------------


def test_false_attribution_rate():
    """false_attribution_rate is always 1 - precision."""
    gold_span = "limitation of liability"
    gold_doc_id = "contract-007"

    # 3 of 4 blocks contain the span
    citations = [
        {"text": "The limitation of liability clause applies here.", "doc_id": "contract-007"},
        {"text": "limitation of liability is capped at the contract value.", "doc_id": "contract-007"},
        {"text": "limitation of liability is waived for wilful misconduct.", "doc_id": "contract-007"},
        {"text": "Payment terms are net-30.", "doc_id": "contract-007"},
    ]

    result = attribution_f1(citations, gold_span, gold_doc_id)

    assert abs(result["false_attribution_rate"] - (1.0 - result["precision"])) < 1e-9


# ---------------------------------------------------------------------------
# 5. NexumRAG handles ConnectionError gracefully
# ---------------------------------------------------------------------------


def test_nexum_rag_handles_connection_error():
    """NexumRAG.query() returns a mock response on ConnectionError — never raises."""
    import requests

    from nexum_rag import NexumRAG

    rag = NexumRAG(nexum_url="http://localhost:9999", anthropic_api_key="fake")

    with patch("requests.post", side_effect=requests.ConnectionError("refused")):
        result = rag.query("What is the governing law?", top_k=5)

    assert "answer" in result
    assert "citations" in result
    assert isinstance(result["citations"], list)
    assert result.get("is_mock") is True


# ---------------------------------------------------------------------------
# 6. VanillaRAG.ingest stores documents
# ---------------------------------------------------------------------------


def test_vanilla_rag_ingest():
    """ingest() stores documents and marks the index as ready."""
    from vanilla_rag import VanillaRAG

    contracts = [
        {"id": "c-001", "title": "Contract A", "text": "This is contract A text."},
        {"id": "c-002", "title": "Contract B", "text": "This is contract B text."},
    ]

    rag = VanillaRAG(anthropic_api_key="fake")

    # Mock all llama_index imports to avoid needing the package installed
    mock_doc_cls = MagicMock()
    mock_index = MagicMock()
    mock_settings = MagicMock()
    mock_splitter = MagicMock()

    with (
        patch.dict(
            "sys.modules",
            {
                "llama_index": MagicMock(),
                "llama_index.core": MagicMock(
                    Document=mock_doc_cls,
                    Settings=mock_settings,
                    VectorStoreIndex=MagicMock(
                        from_documents=MagicMock(return_value=mock_index)
                    ),
                ),
                "llama_index.core.node_parser": MagicMock(
                    SentenceSplitter=MagicMock(return_value=mock_splitter)
                ),
                "llama_index.llms.anthropic": MagicMock(),
            },
        ),
    ):
        rag.ingest(contracts)

    assert rag._documents == contracts
    assert rag._index is not None


# ---------------------------------------------------------------------------
# 7. Corpus loading from a temp JSONL file
# ---------------------------------------------------------------------------


def test_corpus_loading(tmp_path):
    """load_demo_corpus() with a temp JSONL file returns the correct list."""
    from corpus import load_demo_corpus

    contracts = [
        {"id": f"c-{i:04d}", "title": f"Contract {i}", "text": f"Text of contract {i}."}
        for i in range(10)
    ]

    jsonl_path = tmp_path / "contracts.jsonl"
    with jsonl_path.open("w") as fh:
        for c in contracts:
            fh.write(json.dumps(c) + "\n")

    loaded = load_demo_corpus(str(jsonl_path), max_contracts=10)

    assert len(loaded) == 10
    assert loaded[0]["id"] == "c-0000"
    assert loaded[0]["title"] == "Contract 0"
    assert loaded[0]["text"] == "Text of contract 0."


def test_corpus_loading_respects_max(tmp_path):
    """max_contracts caps the number of returned contracts."""
    from corpus import load_demo_corpus

    jsonl_path = tmp_path / "contracts.jsonl"
    with jsonl_path.open("w") as fh:
        for i in range(20):
            fh.write(json.dumps({"id": f"c-{i}", "title": f"T{i}", "text": f"body {i}"}) + "\n")

    loaded = load_demo_corpus(str(jsonl_path), max_contracts=5)
    assert len(loaded) == 5


# ---------------------------------------------------------------------------
# 8. run_demo.py --dry-run produces correct output structure
# ---------------------------------------------------------------------------


def test_run_demo_dry_run(tmp_path):
    """--dry-run flag produces a valid result JSON without any LLM or Nexum calls."""
    import importlib.util

    run_demo_path = _DEMO_DIR / "run_demo.py"
    spec = importlib.util.spec_from_file_location("run_demo", run_demo_path)
    run_demo = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(run_demo)  # type: ignore[union-attr]

    output_file = tmp_path / "g2_test_result.json"

    run_demo.run(
        nexum_url="http://localhost:9999",
        anthropic_key="fake",
        max_contracts=5,
        max_questions=5,
        output_path=output_file,
        dry_run=True,
    )

    assert output_file.exists(), "Output file should be created by dry-run."
    result = json.loads(output_file.read_text())

    # Check top-level structure
    assert "nexum" in result
    assert "vanilla_rag" in result
    assert "delta_attribution_f1" in result
    assert "g2_signal" in result
    assert "n_questions" in result
    assert "per_question" in result

    # Check nested keys
    for system in ("nexum", "vanilla_rag"):
        assert "attribution_f1" in result[system]
        assert "false_attribution_rate" in result[system]
        assert "mean_answer_length" in result[system]

    assert result["g2_signal"] in ("pass", "inconclusive", "fail")
    assert result.get("dry_run") is True
