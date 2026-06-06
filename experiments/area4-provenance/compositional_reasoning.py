"""
H4.2: Multi-hop compositional reasoning benchmark.

Measures accuracy as a function of required graph traversal depth, comparing
Nexum (graph-resident retrieval) vs. vanilla RAG.

Target: Nexum wins over vanilla at hops >= 3.
"""

from __future__ import annotations

import itertools


# ---------------------------------------------------------------------------
# Question construction
# ---------------------------------------------------------------------------

_1HOP_TEMPLATE = (
    'What is the {clause_type} clause in {contract_id}?'
)
_2HOP_TEMPLATE = (
    'Does the {clause_a} in {contract_a} apply to the subsidiary '
    'defined in {contract_b}?'
)
_3HOP_TEMPLATE = (
    "If the governing law in {contract_c} differs from {contract_a}'s "
    "arbitration clause, which prevails given {contract_b}'s "
    "integration clause?"
)
_4HOP_TEMPLATE = (
    "Given that {contract_a}'s {clause_a} references {contract_b}'s "
    "{clause_b}, and {contract_b}'s {clause_b} was amended by "
    "{contract_c}'s {clause_c}, does {contract_d}'s {clause_d} "
    "override all prior terms?"
)
_5HOP_TEMPLATE = (
    "Trace the liability chain from {contract_a} through {contract_b}, "
    "{contract_c}, and {contract_d} to {contract_e}: does the indemnity "
    "in {contract_e} ultimately cover the original obligation in {contract_a}?"
)


def build_multihop_questions(
    contracts: list[dict],
    max_hops: int = 5,
) -> list[dict]:
    """Construct multi-hop questions requiring N hops through the link graph.

    Uses CUAD cross-document relationship patterns to build questions at each
    hop depth from 1 to ``max_hops``.

    Parameters
    ----------
    contracts:
        List of contract dicts.  Each dict should contain:
            - ``contract_id`` : unique identifier
            - ``title``       : display name
            - ``clauses``     : dict mapping clause type names to text
    max_hops:
        Maximum hop depth to generate questions for (1–5).

    Returns
    -------
    List of question dicts, each containing:
        question             : the question text
        n_hops               : number of graph hops required
        gold_answer          : expected answer string
        required_doc_ids     : list of contract IDs needed to answer
        required_clause_types: list of clause type names needed
    """
    questions: list[dict] = []

    if not contracts:
        return questions

    n = len(contracts)
    hop_cap = min(max_hops, 5)

    # 1-hop: single contract, single clause
    if hop_cap >= 1:
        for contract in contracts:
            cid = contract["contract_id"]
            clauses = contract.get("clauses", {})
            for clause_type, clause_text in list(clauses.items())[:2]:
                questions.append(
                    {
                        "question": _1HOP_TEMPLATE.format(
                            clause_type=clause_type, contract_id=cid
                        ),
                        "n_hops": 1,
                        "gold_answer": clause_text,
                        "required_doc_ids": [cid],
                        "required_clause_types": [clause_type],
                    }
                )

    # 2-hop: two contracts
    if hop_cap >= 2 and n >= 2:
        for ca, cb in itertools.combinations(contracts, 2):
            ca_id = ca["contract_id"]
            cb_id = cb["contract_id"]
            clause_a = list(ca.get("clauses", {}).keys())[0] if ca.get("clauses") else "non_compete"
            questions.append(
                {
                    "question": _2HOP_TEMPLATE.format(
                        clause_a=clause_a,
                        contract_a=ca_id,
                        contract_b=cb_id,
                    ),
                    "n_hops": 2,
                    "gold_answer": (
                        f"Depends on the subsidiary definition in {cb_id} "
                        f"and the {clause_a} scope in {ca_id}."
                    ),
                    "required_doc_ids": [ca_id, cb_id],
                    "required_clause_types": [clause_a, "subsidiary_definition"],
                }
            )

    # 3-hop: three contracts
    if hop_cap >= 3 and n >= 3:
        for ca, cb, cc in itertools.combinations(contracts, 3):
            ca_id = ca["contract_id"]
            cb_id = cb["contract_id"]
            cc_id = cc["contract_id"]
            questions.append(
                {
                    "question": _3HOP_TEMPLATE.format(
                        contract_a=ca_id,
                        contract_b=cb_id,
                        contract_c=cc_id,
                    ),
                    "n_hops": 3,
                    "gold_answer": (
                        f"The integration clause in {cb_id} determines "
                        f"which governing law or arbitration clause prevails."
                    ),
                    "required_doc_ids": [ca_id, cb_id, cc_id],
                    "required_clause_types": [
                        "governing_law",
                        "arbitration",
                        "integration",
                    ],
                }
            )

    # 4-hop: four contracts
    if hop_cap >= 4 and n >= 4:
        for combo in itertools.combinations(contracts, 4):
            ca, cb, cc, cd = combo
            ca_id = ca["contract_id"]
            cb_id = cb["contract_id"]
            cc_id = cc["contract_id"]
            cd_id = cd["contract_id"]
            ca_clauses = list(ca.get("clauses", {}).keys())
            cb_clauses = list(cb.get("clauses", {}).keys())
            cc_clauses = list(cc.get("clauses", {}).keys())
            cd_clauses = list(cd.get("clauses", {}).keys())
            clause_a = ca_clauses[0] if ca_clauses else "termination"
            clause_b = cb_clauses[0] if cb_clauses else "governing_law"
            clause_c = cc_clauses[0] if cc_clauses else "amendment"
            clause_d = cd_clauses[0] if cd_clauses else "integration"
            questions.append(
                {
                    "question": _4HOP_TEMPLATE.format(
                        contract_a=ca_id,
                        contract_b=cb_id,
                        contract_c=cc_id,
                        contract_d=cd_id,
                        clause_a=clause_a,
                        clause_b=clause_b,
                        clause_c=clause_c,
                        clause_d=clause_d,
                    ),
                    "n_hops": 4,
                    "gold_answer": (
                        f"Requires tracing {clause_a} through {ca_id}, "
                        f"{cb_id}, {cc_id} to {cd_id}."
                    ),
                    "required_doc_ids": [ca_id, cb_id, cc_id, cd_id],
                    "required_clause_types": [clause_a, clause_b, clause_c, clause_d],
                }
            )

    # 5-hop: five contracts
    if hop_cap >= 5 and n >= 5:
        for combo in itertools.combinations(contracts, 5):
            ca, cb, cc, cd, ce = combo
            ca_id = ca["contract_id"]
            cb_id = cb["contract_id"]
            cc_id = cc["contract_id"]
            cd_id = cd["contract_id"]
            ce_id = ce["contract_id"]
            questions.append(
                {
                    "question": _5HOP_TEMPLATE.format(
                        contract_a=ca_id,
                        contract_b=cb_id,
                        contract_c=cc_id,
                        contract_d=cd_id,
                        contract_e=ce_id,
                    ),
                    "n_hops": 5,
                    "gold_answer": (
                        f"Full liability chain analysis across {ca_id}, "
                        f"{cb_id}, {cc_id}, {cd_id}, {ce_id} required."
                    ),
                    "required_doc_ids": [ca_id, cb_id, cc_id, cd_id, ce_id],
                    "required_clause_types": [
                        "indemnity",
                        "liability",
                        "assignment",
                        "governing_law",
                        "integration",
                    ],
                }
            )

    return questions


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------

def _judge_answer(
    predicted: str,
    gold: str,
    judge_model: str | None,
) -> bool:
    """Determine whether predicted answer matches gold.

    When ``judge_model`` is None (test/offline mode), falls back to an exact
    case-insensitive match to avoid any API dependency.
    """
    if judge_model is None:
        return predicted.strip().lower() == gold.strip().lower()

    # Production mode: delegate to an LLM judge via the Anthropic SDK.
    try:
        import anthropic  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "anthropic SDK required for LLM judge; "
            "install with: pip install anthropic"
        ) from exc

    client = anthropic.Anthropic()
    prompt = (
        f"Gold answer: {gold}\n\n"
        f"Predicted answer: {predicted}\n\n"
        "Does the predicted answer correctly answer the question given the "
        "gold answer? Reply with only YES or NO."
    )
    message = client.messages.create(
        model=judge_model,
        max_tokens=8,
        messages=[{"role": "user", "content": prompt}],
    )
    reply = message.content[0].text.strip().upper()
    return reply.startswith("YES")


def run_compositional_benchmark(
    nexum_client,
    vanilla_client,
    multihop_questions: list[dict],
    judge_model: str | None = None,
) -> dict:
    """H4.2: Measure accuracy as a function of required hops.

    Parameters
    ----------
    nexum_client:
        Client with ``query(question: str) -> dict`` (returns ``answer`` key).
    vanilla_client:
        Vanilla RAG client with the same interface.
    multihop_questions:
        List of question dicts from ``build_multihop_questions``.
    judge_model:
        Anthropic model name used as the LLM judge.  Defaults to ``None``
        (exact-match mode, no API calls required).  Pass
        ``"claude-haiku-4-5-20251001"`` for live evaluation.

    Returns
    -------
    dict keyed by hop count (1–5) plus summary keys:
        {n_hops: {"nexum_accuracy": float, "vanilla_accuracy": float, "nexum_better": bool}}
        "min_hops_where_nexum_wins": int | None
        "h4_2_supported": bool  (True if nexum_better at all hops >= 3)
    """
    # Group questions by hop count
    by_hops: dict[int, list[dict]] = {}
    for q in multihop_questions:
        n = q["n_hops"]
        by_hops.setdefault(n, []).append(q)

    result: dict = {}

    for n_hops, qs in sorted(by_hops.items()):
        nexum_correct = 0
        vanilla_correct = 0

        for q in qs:
            gold = q["gold_answer"]
            nexum_resp = nexum_client.query(q["question"])
            vanilla_resp = vanilla_client.query(q["question"])

            if _judge_answer(nexum_resp.get("answer", ""), gold, judge_model):
                nexum_correct += 1
            if _judge_answer(vanilla_resp.get("answer", ""), gold, judge_model):
                vanilla_correct += 1

        n = len(qs)
        nexum_acc = nexum_correct / n if n else 0.0
        vanilla_acc = vanilla_correct / n if n else 0.0

        result[n_hops] = {
            "nexum_accuracy": round(nexum_acc, 4),
            "vanilla_accuracy": round(vanilla_acc, 4),
            "nexum_better": nexum_acc > vanilla_acc,
        }

    # Summary fields
    wins_at = [n for n, v in result.items() if v["nexum_better"]]
    min_hops_where_nexum_wins = min(wins_at) if wins_at else None

    # h4_2_supported: Nexum must win at every measured hop >= 3
    hop3_and_up = [n for n in result if n >= 3]
    if hop3_and_up:
        h4_2_supported = all(result[n]["nexum_better"] for n in hop3_and_up)
    else:
        h4_2_supported = False

    result["min_hops_where_nexum_wins"] = min_hops_where_nexum_wins
    result["h4_2_supported"] = h4_2_supported

    return result
