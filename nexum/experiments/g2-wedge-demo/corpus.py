"""
Corpus preparation for the G2 wedge demo.

Loads a subset of CUAD contracts and evaluation QA pairs.
Falls back to generating a tiny synthetic corpus when the CUAD fixture
has not been downloaded yet (useful for CI / dry-run).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_DEFAULT_CUAD_CONTRACTS = (
    "../../experiments/lab-bench/data/cuad/contracts.jsonl"
)
_DEFAULT_CUAD_QA = (
    "../../experiments/lab-bench/data/cuad/qa.jsonl"
)


def load_demo_corpus(
    cuad_path: str = _DEFAULT_CUAD_CONTRACTS,
    max_contracts: int = 50,
) -> list[dict]:
    """Load the first N CUAD contracts.

    Returns a list of ``{id, title, text}`` dicts.  If the CUAD file does not
    exist, returns a minimal synthetic corpus so that tests and dry-runs work
    without downloading the dataset.
    """
    path = Path(cuad_path)
    if not path.exists():
        logger.warning(
            "CUAD contracts not found at %s — returning synthetic corpus. "
            "Run experiments/lab-bench/fixtures/cuad.py to download.",
            cuad_path,
        )
        return _synthetic_corpus(max_contracts)

    contracts: list[dict] = []
    with path.open() as fh:
        for line in fh:
            if len(contracts) >= max_contracts:
                break
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            contracts.append(
                {
                    "id": raw["id"],
                    "title": raw.get("title", raw["id"]),
                    "text": raw["text"],
                }
            )

    logger.info("Loaded %d contracts from %s", len(contracts), cuad_path)
    return contracts


def load_eval_questions(
    qa_path: str = _DEFAULT_CUAD_QA,
    max_questions: int = 50,
) -> list[dict]:
    """Load QA pairs with gold answer spans for attribution evaluation.

    Returns a list of::

        {
            "id": str,
            "contract_id": str,
            "question": str,
            "gold_span": str,   # first non-empty answer text
        }

    Rows with no answer text are skipped.  If the file does not exist, returns
    synthetic QA pairs that match the synthetic corpus from
    :func:`load_demo_corpus`.
    """
    path = Path(qa_path)
    if not path.exists():
        logger.warning(
            "CUAD QA not found at %s — returning synthetic questions.",
            qa_path,
        )
        return _synthetic_questions(max_questions)

    questions: list[dict] = []
    with path.open() as fh:
        for line in fh:
            if len(questions) >= max_questions:
                break
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            answers = raw.get("answers", {})
            texts = answers.get("text", []) if isinstance(answers, dict) else []
            gold_span = next((t for t in texts if t and t.strip()), None)
            if gold_span is None:
                continue  # skip unanswerable questions
            questions.append(
                {
                    "id": raw["id"],
                    "contract_id": raw["contract_id"],
                    "question": raw["question"],
                    "gold_span": gold_span.strip(),
                }
            )

    logger.info("Loaded %d eval questions from %s", len(questions), qa_path)
    return questions


# ---------------------------------------------------------------------------
# Synthetic fallback helpers (used when CUAD has not been downloaded)
# ---------------------------------------------------------------------------

_SYNTHETIC_CLAUSES = [
    (
        "Confidentiality",
        "Each party agrees to keep the other party's information confidential "
        "and not to disclose it to any third party without prior written consent.",
    ),
    (
        "Governing Law",
        "This Agreement shall be governed by and construed in accordance with "
        "the laws of the State of Delaware, without regard to conflict of law principles.",
    ),
    (
        "Termination",
        "Either party may terminate this Agreement upon thirty (30) days written "
        "notice to the other party.",
    ),
    (
        "Limitation of Liability",
        "In no event shall either party be liable for any indirect, incidental, "
        "special, or consequential damages arising out of or related to this Agreement.",
    ),
    (
        "Intellectual Property",
        "All intellectual property created under this Agreement shall be and remain "
        "the exclusive property of the Company.",
    ),
]


def _synthetic_corpus(n: int) -> list[dict]:
    contracts = []
    for i in range(n):
        clause_title, clause_text = _SYNTHETIC_CLAUSES[i % len(_SYNTHETIC_CLAUSES)]
        contracts.append(
            {
                "id": f"synthetic-contract-{i:04d}",
                "title": f"Synthetic Contract {i:04d} — {clause_title}",
                "text": (
                    f"CONTRACT {i:04d}\n\n"
                    f"SECTION 1. {clause_title.upper()}\n\n"
                    f"{clause_text}\n\n"
                    "SECTION 2. GENERAL PROVISIONS\n\n"
                    "This agreement constitutes the entire understanding between "
                    "the parties with respect to the subject matter hereof."
                ),
            }
        )
    return contracts


def _synthetic_questions(n: int) -> list[dict]:
    templates = [
        ("What is the confidentiality obligation?", 0, _SYNTHETIC_CLAUSES[0][1]),
        ("Which state's law governs this agreement?", 1, "State of Delaware"),
        ("How much notice is required for termination?", 2, "thirty (30) days"),
        ("Is indirect damage liability excluded?", 3, "indirect, incidental, special, or consequential damages"),
        ("Who owns the intellectual property?", 4, "exclusive property of the Company"),
    ]
    questions = []
    for i in range(n):
        q_text, contract_idx, gold_span = templates[i % len(templates)]
        questions.append(
            {
                "id": f"synthetic-qa-{i:06d}",
                "contract_id": f"synthetic-contract-{contract_idx:04d}",
                "question": q_text,
                "gold_span": gold_span,
            }
        )
    return questions
