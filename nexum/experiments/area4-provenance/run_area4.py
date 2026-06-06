"""
Area 4 orchestrator CLI.

Usage
-----
python run_area4.py \\
  --nexum-url http://localhost:3000 \\
  --anthropic-key $ANTHROPIC_API_KEY \\
  --cuad-path ../../experiments/lab-bench/data/cuad \\
  --max-questions 100 \\
  --output results/area4_results.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# Minimal Nexum and vanilla clients
# ---------------------------------------------------------------------------

class NexumClient:
    """HTTP client for a running Nexum server."""

    def __init__(self, base_url: str, api_key: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.headers = {}
        if api_key:
            self.headers["Authorization"] = f"Bearer {api_key}"

    def query(self, question: str) -> dict:
        import requests  # noqa: F401 — guarded import for offline mode

        resp = requests.post(
            f"{self.base_url}/query",
            json={"question": question},
            headers=self.headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


class VanillaClient:
    """Minimal LlamaIndex-backed vanilla RAG client."""

    def __init__(self, cuad_path: str, anthropic_key: str | None = None):
        self._cuad_path = cuad_path
        self._anthropic_key = anthropic_key
        self._index = None

    def _build_index(self):
        from llama_index.core import SimpleDirectoryReader, VectorStoreIndex

        docs = SimpleDirectoryReader(self._cuad_path).load_data()
        self._index = VectorStoreIndex.from_documents(docs)

    def query(self, question: str) -> dict:
        if self._index is None:
            self._build_index()
        engine = self._index.as_query_engine()
        resp = engine.query(question)
        source_nodes = [
            {"text": n.text, "doc_id": n.metadata.get("file_name", "")}
            for n in getattr(resp, "source_nodes", [])
        ]
        return {"answer": str(resp), "source_nodes": source_nodes}


# ---------------------------------------------------------------------------
# CUAD loader
# ---------------------------------------------------------------------------

def load_cuad_questions(cuad_path: str, max_questions: int) -> list[dict]:
    """Load evaluation questions from CUAD data directory."""
    cuad_path = Path(cuad_path)
    squad_file = cuad_path / "train.json"

    questions: list[dict] = []

    if squad_file.exists():
        with open(squad_file) as f:
            data = json.load(f)
        for doc in data.get("data", []):
            for para in doc.get("paragraphs", []):
                context = para.get("context", "")
                for qa in para.get("qas", []):
                    if len(questions) >= max_questions:
                        break
                    answers = qa.get("answers", [])
                    if not answers:
                        continue
                    questions.append(
                        {
                            "question": qa["question"],
                            "gold_answer_span": answers[0]["text"],
                            "gold_doc_id": doc.get("title", "unknown"),
                            "gold_block_hint": context[:100],
                        }
                    )
    else:
        print(
            f"[warn] CUAD train.json not found at {squad_file}. "
            "Using synthetic placeholder questions.",
            file=sys.stderr,
        )
        for i in range(min(max_questions, 5)):
            questions.append(
                {
                    "question": f"Synthetic question {i}?",
                    "gold_answer_span": f"synthetic answer {i}",
                    "gold_doc_id": f"synthetic_doc_{i}",
                    "gold_block_hint": "placeholder",
                }
            )

    return questions[:max_questions]


def load_cuad_contracts(cuad_path: str, max_contracts: int = 20) -> list[dict]:
    """Load contracts from CUAD for multi-hop question construction."""
    cuad_path = Path(cuad_path)
    squad_file = cuad_path / "train.json"
    contracts: list[dict] = []

    if squad_file.exists():
        with open(squad_file) as f:
            data = json.load(f)
        for doc in data.get("data", []):
            if len(contracts) >= max_contracts:
                break
            clauses: dict[str, str] = {}
            for para in doc.get("paragraphs", [])[:1]:
                for qa in para.get("qas", [])[:5]:
                    answers = qa.get("answers", [])
                    if answers:
                        key = qa["question"][:40].lower().replace(" ", "_")
                        clauses[key] = answers[0]["text"]
            contracts.append(
                {
                    "contract_id": doc.get("title", f"contract_{len(contracts)}"),
                    "title": doc.get("title", ""),
                    "clauses": clauses,
                }
            )
    else:
        for i in range(min(max_contracts, 5)):
            contracts.append(
                {
                    "contract_id": f"synthetic_contract_{i}",
                    "title": f"Synthetic Agreement {i}",
                    "clauses": {
                        "termination": "30 days notice required.",
                        "governing_law": "New York law applies.",
                        "non_compete": "12-month non-compete.",
                    },
                }
            )

    return contracts[:max_contracts]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Area 4: Provenance and compositional reasoning experiments"
    )
    parser.add_argument("--nexum-url", default="http://localhost:3000")
    parser.add_argument("--anthropic-key", default=os.environ.get("ANTHROPIC_API_KEY"))
    parser.add_argument("--cuad-path", default="../../experiments/lab-bench/data/cuad")
    parser.add_argument("--max-questions", type=int, default=100)
    parser.add_argument("--output", default="results/area4_results.json")
    parser.add_argument("--skip-h4-2", action="store_true")
    parser.add_argument("--skip-h4-3", action="store_true")
    args = parser.parse_args()

    from attribution_audit import run_attribution_audit
    from compositional_reasoning import build_multihop_questions, run_compositional_benchmark
    from auditability_report import generate_auditability_comparison
    from skew_test import simulate_skew_test

    print("[area4] Loading evaluation questions from CUAD ...")
    eval_questions = load_cuad_questions(args.cuad_path, args.max_questions)
    print(f"[area4] Loaded {len(eval_questions)} questions.")

    nexum = NexumClient(args.nexum_url)
    vanilla = VanillaClient(args.cuad_path, args.anthropic_key)

    results: dict = {}

    # H4.4 — Attribution audit
    print("[area4] Running H4.4 attribution audit ...")
    t0 = time.time()
    h4_4 = run_attribution_audit(nexum, eval_questions, expert_sample_size=50)
    results["h4_4_attribution_audit"] = h4_4
    print(
        f"[area4] H4.4 done in {time.time()-t0:.1f}s — "
        f"precision={h4_4['precision']:.3f}, "
        f"FAR={h4_4['false_attribution_rate']:.3f}, "
        f"supported={h4_4['h4_4_supported']}"
    )

    # H4.2 — Compositional reasoning
    if not args.skip_h4_2:
        print("[area4] Building multi-hop questions ...")
        contracts = load_cuad_contracts(args.cuad_path)
        multihop_qs = build_multihop_questions(contracts, max_hops=5)
        print(f"[area4] Built {len(multihop_qs)} multi-hop questions.")

        print("[area4] Running H4.2 compositional benchmark ...")
        t0 = time.time()
        h4_2 = run_compositional_benchmark(
            nexum, vanilla, multihop_qs,
            judge_model="claude-haiku-4-5-20251001",
        )
        results["h4_2_compositional_reasoning"] = h4_2
        print(
            f"[area4] H4.2 done in {time.time()-t0:.1f}s — "
            f"min_hops_where_nexum_wins={h4_2['min_hops_where_nexum_wins']}, "
            f"supported={h4_2['h4_2_supported']}"
        )

    # H4.1 — Auditability comparison
    print("[area4] Running H4.1 auditability comparison ...")
    sample_qs = eval_questions[:20]
    nexum_answers = []
    vanilla_answers = []
    for item in sample_qs:
        q = item["question"]
        nexum_answers.append(nexum.query(q))
        vanilla_answers.append(vanilla.query(q))

    h4_1 = generate_auditability_comparison(nexum_answers, vanilla_answers, sample_qs)
    results["h4_1_auditability"] = h4_1
    print(f"[area4] H4.1 — {h4_1['h4_1_signal']}")

    # H4.3 — Skew test (measurement)
    if not args.skip_h4_3:
        print("[area4] Running H4.3 skew measurement ...")
        h4_3 = simulate_skew_test(nexum, vanilla, vanilla, sample_qs)
        results["h4_3_skew_measurement"] = h4_3
        print(
            f"[area4] H4.3 — nexum_accuracy={h4_3['nexum_accuracy']:.3f}, "
            f"skew_penalty={h4_3['skew_penalty']:.3f}, "
            f"nexum_vs_stale_delta={h4_3['nexum_vs_stale_delta']:.3f}"
        )

    # Save
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"[area4] Results written to {output_path}")


if __name__ == "__main__":
    main()
