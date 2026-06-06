"""
traversal_diagnostics.py — G1-OPT-2 deep graph traversal latency diagnosis.

Implements the diagnosis protocol from issue #74 for the recursive CTE
graph traversal that exhibits 6-hop P99 = 10923 ms on the 1M-block link
graph. The module is structured so each step (and each fix candidate)
can be invoked independently and produces structured measurements that
roll up into a single result envelope shareable via
`experiments._lib.results_writer`.

Diagnosis steps:

- Step 1 — `explain_analyze_traversal`
    Run ``EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`` on the recursive
    CTE and extract: index used on the recursive join, planned vs.
    actual rows on the recursive term, buffer reads, and total
    intermediate row count before ``DISTINCT``.

- Step 2 — `measure_fanout`
    Per-hop ``raw_count`` vs. ``count(DISTINCT id)`` so we can quantify
    whether the cycle guard is actually shrinking the frontier or
    whether the fan-out is exponential.

- Step 3 — `cycle_guard_ablation`
    Run the same query with and without the
    ``l.src != ALL(t.path)`` predicate and compare wall time. A
    dramatic speed-up identifies the cycle guard as the bottleneck.

Fix candidates (each returns its own latency stats so they can be
benchmarked in the same harness as the baseline):

- Fix A — `bench_covering_index`     covering ``(src, layer) INCLUDE (dst, rel_type, weight)``
- Fix B — `bench_work_mem`           ``SET work_mem`` knob sweep
- Fix C — `bench_topk_fanout`        ``ROW_NUMBER()``-bounded top-k per hop
- Fix D — `bench_iterative_bfs`      application-side BFS using ``WHERE src = ANY($frontier)``

Postgres-only — no external graph databases. Apache AGE / pgrouting
fallbacks are intentionally NOT implemented in this module; they are
out-of-scope unless A–D fail to bring 6-hop P99 below 500 ms (per the
acceptance criteria of issue #74).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import numpy as np

# Reuse the gate-wide pass threshold so a 6-hop fix is judged by the
# same yardstick as the rest of G1.
from benchmark import G1_P99_THRESHOLD_MS

# Layers the production query layer accepts. Mirrors the
# ``layer = ANY(...)`` predicate in src/routes/query.ts.
_DEFAULT_LAYERS: tuple[str, ...] = ("structural", "semantic", "ai")

# Hop depths we always report on, so the result envelope schema is
# stable across runs and across fix candidates.
_REPORT_HOPS: tuple[int, ...] = (2, 4, 6)


# ---------------------------------------------------------------------------
# Result envelopes
# ---------------------------------------------------------------------------


@dataclass
class LatencyStats:
    """Latency stats in milliseconds for a single (fix, hop_depth) pair."""

    hop_depth: int
    n_queries: int
    p50_ms: float
    p99_ms: float
    mean_ms: float

    def passes_g1(self) -> bool:
        """G1 acceptance: P99 below the gate threshold."""
        return self.p99_ms < G1_P99_THRESHOLD_MS

    def to_dict(self) -> dict[str, Any]:
        return {
            "hop_depth": self.hop_depth,
            "n_queries": self.n_queries,
            "p50_ms": self.p50_ms,
            "p99_ms": self.p99_ms,
            "mean_ms": self.mean_ms,
            "passes_g1": self.passes_g1(),
        }


@dataclass
class DiagnosticReport:
    """Top-level result envelope for a full diagnosis run."""

    n_blocks: int
    n_links: int
    seed_count: int
    explain_summary: dict[str, Any] = field(default_factory=dict)
    fanout_per_hop: list[dict[str, int]] = field(default_factory=list)
    cycle_guard_ablation: dict[str, Any] = field(default_factory=dict)
    baseline_stats: list[dict[str, Any]] = field(default_factory=list)
    fix_a_stats: list[dict[str, Any]] = field(default_factory=list)
    fix_b_stats: list[dict[str, Any]] = field(default_factory=list)
    fix_c_stats: list[dict[str, Any]] = field(default_factory=list)
    fix_d_stats: list[dict[str, Any]] = field(default_factory=list)
    chosen_fix: str | None = None
    chosen_fix_rationale: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "n_blocks": self.n_blocks,
            "n_links": self.n_links,
            "seed_count": self.seed_count,
            "explain_summary": self.explain_summary,
            "fanout_per_hop": self.fanout_per_hop,
            "cycle_guard_ablation": self.cycle_guard_ablation,
            "baseline_stats": self.baseline_stats,
            "fix_a_stats": self.fix_a_stats,
            "fix_b_stats": self.fix_b_stats,
            "fix_c_stats": self.fix_c_stats,
            "fix_d_stats": self.fix_d_stats,
            "chosen_fix": self.chosen_fix,
            "chosen_fix_rationale": self.chosen_fix_rationale,
        }


# ---------------------------------------------------------------------------
# SQL fragments
# ---------------------------------------------------------------------------


# Baseline traversal — kept byte-identical to the production query in
# src/routes/query.ts so latency numbers are directly comparable.
_BASELINE_SQL = """
WITH RECURSIVE traversal AS (
    SELECT dst AS id, 1 AS depth, ARRAY[src] AS path, rel_type
    FROM links
    WHERE src = %(seed)s AND layer = ANY(%(layers)s)
    UNION ALL
    SELECT l.dst, t.depth + 1, t.path || l.src, l.rel_type
    FROM links l
    JOIN traversal t ON l.src = t.id
    WHERE t.depth < %(max_depth)s AND l.src != ALL(t.path)
)
SELECT DISTINCT id, depth, rel_type
FROM traversal
ORDER BY depth
LIMIT 100
"""

# Step 2 — strip the ``DISTINCT`` so we can count both raw and distinct
# rows produced at each level.
_FANOUT_SQL = """
WITH RECURSIVE traversal AS (
    SELECT dst AS id, 1 AS depth
    FROM links
    WHERE src = %(seed)s AND layer = ANY(%(layers)s)
    UNION ALL
    SELECT l.dst, t.depth + 1
    FROM links l
    JOIN traversal t ON l.src = t.id
    WHERE t.depth < %(max_depth)s
)
SELECT depth, COUNT(*) AS raw_count, COUNT(DISTINCT id) AS distinct_count
FROM traversal
GROUP BY depth
ORDER BY depth
"""

# Step 3 — same as baseline but without the ``!= ALL(path)`` cycle
# guard. UNSAFE on a cyclic graph at large depth; we cap n_queries
# small in the ablation to bound cost.
_NO_CYCLE_GUARD_SQL = """
WITH RECURSIVE traversal AS (
    SELECT dst AS id, 1 AS depth, rel_type
    FROM links
    WHERE src = %(seed)s AND layer = ANY(%(layers)s)
    UNION ALL
    SELECT l.dst, t.depth + 1, l.rel_type
    FROM links l
    JOIN traversal t ON l.src = t.id
    WHERE t.depth < %(max_depth)s
)
SELECT DISTINCT id, depth, rel_type
FROM traversal
ORDER BY depth
LIMIT 100
"""

# Fix C — top-k highest-weight outgoing edges per (src, layer).
_TOPK_FANOUT_SQL = """
WITH RECURSIVE traversal AS (
    SELECT dst AS id, 1 AS depth, ARRAY[src] AS path, rel_type
    FROM links
    WHERE src = %(seed)s AND layer = ANY(%(layers)s)
    UNION ALL
    SELECT l.dst, t.depth + 1, t.path || l.src, l.rel_type
    FROM (
        SELECT dst, src, rel_type, layer,
               ROW_NUMBER() OVER (PARTITION BY src, layer
                                  ORDER BY weight DESC) AS rn
        FROM links
    ) l
    JOIN traversal t ON l.src = t.id
    WHERE t.depth < %(max_depth)s
      AND l.src != ALL(t.path)
      AND l.rn <= %(topk)s
)
SELECT DISTINCT id, depth, rel_type
FROM traversal
ORDER BY depth
LIMIT 100
"""

_COVERING_INDEX_DDL = """
CREATE INDEX IF NOT EXISTS links_src_layer_cover_idx
    ON links (src, layer)
    INCLUDE (dst, rel_type, weight)
"""

_DROP_COVERING_INDEX_DDL = "DROP INDEX IF EXISTS links_src_layer_cover_idx"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _percentiles(latencies_ms: Sequence[float], hop_depth: int) -> LatencyStats:
    """Compute LatencyStats from a sequence of millisecond samples."""
    if not latencies_ms:
        return LatencyStats(hop_depth, 0, 0.0, 0.0, 0.0)
    arr = np.asarray(latencies_ms, dtype=np.float64)
    return LatencyStats(
        hop_depth=hop_depth,
        n_queries=int(arr.size),
        p50_ms=float(np.percentile(arr, 50)),
        p99_ms=float(np.percentile(arr, 99)),
        mean_ms=float(np.mean(arr)),
    )


def _time_query(cur, sql: str, params: dict[str, Any]) -> float:
    """Execute *sql* and return wall-time in milliseconds."""
    t0 = time.perf_counter()
    cur.execute(sql, params)
    cur.fetchall()
    return (time.perf_counter() - t0) * 1000.0


def _count(conn, sql: str) -> int:
    """Run a one-row scalar count query and return its int result."""
    with conn.cursor() as cur:
        cur.execute(sql)
        row = cur.fetchone()
        return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Step 1 — EXPLAIN ANALYZE
# ---------------------------------------------------------------------------


def explain_analyze_traversal(
    conn,
    seed_id: str,
    max_depth: int = 6,
    layers: Iterable[str] = _DEFAULT_LAYERS,
) -> dict[str, Any]:
    """Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on the baseline query.

    Returns a small structured summary derived from the JSON plan. The full
    plan is also returned under ``raw_plan`` for debugging.
    """
    layers_list = list(layers)
    with conn.cursor() as cur:
        cur.execute(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + _BASELINE_SQL,
            {"seed": seed_id, "layers": layers_list, "max_depth": max_depth},
        )
        rows = cur.fetchall()

    if not rows or not rows[0] or not rows[0][0]:
        return {"error": "empty plan"}

    plan_envelope = rows[0][0]
    if isinstance(plan_envelope, list):
        plan_envelope = plan_envelope[0]
    plan = plan_envelope.get("Plan", {})

    indexes_used: list[str] = []
    heap_fetches = 0
    shared_read = 0
    seq_scans: list[str] = []

    def _walk(node: dict[str, Any]) -> None:
        nonlocal heap_fetches, shared_read
        node_type = node.get("Node Type", "")
        idx_name = node.get("Index Name")
        if idx_name:
            indexes_used.append(idx_name)
        if node_type == "Seq Scan":
            seq_scans.append(node.get("Relation Name", "?"))
        heap_fetches += int(node.get("Heap Fetches", 0) or 0)
        shared_read += int(node.get("Shared Read Blocks", 0) or 0)
        for child in node.get("Plans", []) or []:
            _walk(child)

    _walk(plan)

    return {
        "indexes_used": indexes_used,
        "seq_scans_on_links": [r for r in seq_scans if r == "links"],
        "heap_fetches_total": heap_fetches,
        "shared_read_blocks_total": shared_read,
        "execution_time_ms": plan_envelope.get("Execution Time"),
        "planning_time_ms": plan_envelope.get("Planning Time"),
        "raw_plan": plan_envelope,
    }


# ---------------------------------------------------------------------------
# Step 2 — fan-out measurement
# ---------------------------------------------------------------------------


def measure_fanout(
    conn,
    seed_ids: Sequence[str],
    max_depth: int = 6,
    layers: Iterable[str] = _DEFAULT_LAYERS,
) -> list[dict[str, int]]:
    """Aggregate per-hop ``raw_count`` and ``distinct_count`` across seeds."""
    layers_list = list(layers)
    accum: dict[int, dict[str, int]] = {}
    with conn.cursor() as cur:
        for seed_id in seed_ids:
            cur.execute(
                _FANOUT_SQL,
                {
                    "seed": seed_id,
                    "layers": layers_list,
                    "max_depth": max_depth,
                },
            )
            for depth, raw_count, distinct_count in cur.fetchall():
                bucket = accum.setdefault(
                    int(depth), {"raw_count": 0, "distinct_count": 0, "n_seeds": 0}
                )
                bucket["raw_count"] += int(raw_count)
                bucket["distinct_count"] += int(distinct_count)
                bucket["n_seeds"] += 1

    return [
        {"depth": depth, **accum[depth]}
        for depth in sorted(accum.keys())
    ]


# ---------------------------------------------------------------------------
# Step 3 — cycle guard ablation
# ---------------------------------------------------------------------------


def cycle_guard_ablation(
    conn,
    seed_ids: Sequence[str],
    max_depth: int = 6,
    layers: Iterable[str] = _DEFAULT_LAYERS,
) -> dict[str, Any]:
    """Compare baseline (with cycle guard) vs. no-guard on the same seeds.

    A large speed-up after dropping the guard implies the array-containment
    check ``l.src != ALL(t.path)`` is the bottleneck and Fix A/D should
    target it specifically (e.g., visited-set join).
    """
    layers_list = list(layers)
    with_guard: list[float] = []
    without_guard: list[float] = []

    with conn.cursor() as cur:
        for seed_id in seed_ids:
            params = {
                "seed": seed_id,
                "layers": layers_list,
                "max_depth": max_depth,
            }
            with_guard.append(_time_query(cur, _BASELINE_SQL, params))
            without_guard.append(_time_query(cur, _NO_CYCLE_GUARD_SQL, params))

    with_stats = _percentiles(with_guard, max_depth)
    without_stats = _percentiles(without_guard, max_depth)
    speedup = (
        with_stats.p99_ms / without_stats.p99_ms
        if without_stats.p99_ms > 0
        else 0.0
    )
    return {
        "max_depth": max_depth,
        "with_guard": with_stats.to_dict(),
        "without_guard": without_stats.to_dict(),
        "p99_speedup_x": speedup,
        "guard_is_dominant": speedup > 2.0,
    }


# ---------------------------------------------------------------------------
# Baseline + Fix benchmarks
# ---------------------------------------------------------------------------


def _bench_query_at_hops(
    conn,
    sql: str,
    seed_ids: Sequence[str],
    rng: np.random.Generator,
    n_queries: int,
    layers: Iterable[str],
    extra_params: dict[str, Any] | None = None,
) -> list[LatencyStats]:
    """Run *sql* across ``_REPORT_HOPS`` and return per-hop stats."""
    layers_list = list(layers)
    extra_params = extra_params or {}
    if not seed_ids:
        return [LatencyStats(h, 0, 0.0, 0.0, 0.0) for h in _REPORT_HOPS]

    n_seeds = len(seed_ids)
    per_hop: dict[int, list[float]] = {h: [] for h in _REPORT_HOPS}
    with conn.cursor() as cur:
        for _ in range(n_queries):
            seed_id = seed_ids[int(rng.integers(0, n_seeds))]
            for max_depth in _REPORT_HOPS:
                params = {
                    "seed": seed_id,
                    "layers": layers_list,
                    "max_depth": max_depth,
                    **extra_params,
                }
                per_hop[max_depth].append(_time_query(cur, sql, params))

    return [_percentiles(per_hop[h], h) for h in _REPORT_HOPS]


def bench_baseline(conn, seed_ids, rng, n_queries, layers=_DEFAULT_LAYERS):
    """Reference run — recursive CTE exactly as it ships in production."""
    return _bench_query_at_hops(conn, _BASELINE_SQL, seed_ids, rng, n_queries, layers)


def bench_covering_index(conn, seed_ids, rng, n_queries, layers=_DEFAULT_LAYERS):
    """Fix A — create covering index, re-run baseline, leave the index in place.

    The index is created idempotently; callers that want a clean slate can
    invoke ``drop_covering_index`` afterwards.
    """
    with conn.cursor() as cur:
        cur.execute(_COVERING_INDEX_DDL)
    return _bench_query_at_hops(conn, _BASELINE_SQL, seed_ids, rng, n_queries, layers)


def drop_covering_index(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_DROP_COVERING_INDEX_DDL)


def bench_work_mem(
    conn,
    seed_ids,
    rng,
    n_queries,
    work_mem: str = "256MB",
    layers=_DEFAULT_LAYERS,
):
    """Fix B — bump work_mem for the session, re-run baseline."""
    with conn.cursor() as cur:
        # Quote the value so values like '256MB' are accepted as text
        # by the SET parser. Whitelist input: refuse anything that
        # isn't a digit-letter mix to avoid SQL injection via env var.
        if not work_mem.replace(" ", "").isalnum():
            raise ValueError(f"invalid work_mem value: {work_mem!r}")
        cur.execute(f"SET work_mem = '{work_mem}'")
    return _bench_query_at_hops(conn, _BASELINE_SQL, seed_ids, rng, n_queries, layers)


def bench_topk_fanout(
    conn,
    seed_ids,
    rng,
    n_queries,
    topk: int = 5,
    layers=_DEFAULT_LAYERS,
):
    """Fix C — bound out-degree to the top-k highest-weight edges per node.

    Returns latency stats. The caller is responsible for separately
    measuring recall loss (path-coverage) since recall depends on the
    workload, not the query plan.
    """
    if topk < 1:
        raise ValueError("topk must be >= 1")
    return _bench_query_at_hops(
        conn,
        _TOPK_FANOUT_SQL,
        seed_ids,
        rng,
        n_queries,
        layers,
        extra_params={"topk": topk},
    )


def bench_iterative_bfs(
    conn,
    seed_ids,
    rng,
    n_queries,
    layers=_DEFAULT_LAYERS,
    per_hop_limit: int = 200,
):
    """Fix D — application-side BFS using ``WHERE src = ANY($frontier)``.

    Each hop is a single indexed lookup; no recursive plan, no array
    cycle guard. Memory is bounded by the visited set kept in
    Python.
    """
    layers_list = list(layers)
    if not seed_ids:
        return [LatencyStats(h, 0, 0.0, 0.0, 0.0) for h in _REPORT_HOPS]

    n_seeds = len(seed_ids)
    per_hop: dict[int, list[float]] = {h: [] for h in _REPORT_HOPS}
    sql = (
        "SELECT DISTINCT dst, rel_type FROM links "
        "WHERE src = ANY(%(frontier)s) AND layer = ANY(%(layers)s) "
        "LIMIT %(limit)s"
    )

    with conn.cursor() as cur:
        for _ in range(n_queries):
            seed_id = seed_ids[int(rng.integers(0, n_seeds))]
            for max_depth in _REPORT_HOPS:
                t0 = time.perf_counter()
                visited: set[str] = {seed_id}
                frontier: list[str] = [seed_id]
                for _depth in range(1, max_depth + 1):
                    if not frontier:
                        break
                    cur.execute(
                        sql,
                        {
                            "frontier": frontier,
                            "layers": layers_list,
                            "limit": per_hop_limit,
                        },
                    )
                    next_frontier: list[str] = []
                    for dst, _rel in cur.fetchall():
                        if dst not in visited:
                            visited.add(dst)
                            next_frontier.append(dst)
                    frontier = next_frontier
                per_hop[max_depth].append((time.perf_counter() - t0) * 1000.0)

    return [_percentiles(per_hop[h], h) for h in _REPORT_HOPS]


# ---------------------------------------------------------------------------
# Top-level orchestration
# ---------------------------------------------------------------------------


def _stats_to_dict_list(stats: Sequence[LatencyStats]) -> list[dict[str, Any]]:
    return [s.to_dict() for s in stats]


def _choose_fix(
    baseline: Sequence[LatencyStats],
    candidates: dict[str, Sequence[LatencyStats]],
) -> tuple[str | None, str]:
    """Pick the simplest fix that brings 6-hop P99 below the gate threshold.

    Preference order matches the issue's "low-hanging fruit" order: A
    (covering index, no semantic change) → B (work_mem) → D (iterative
    BFS, no recall loss) → C (top-k, recall loss). The function returns
    ``(name, rationale)``; ``name`` is None if no fix passes.
    """
    preferred_order = ("fix_a", "fix_b", "fix_d", "fix_c")
    baseline_six = next(
        (s for s in baseline if s.hop_depth == 6), None
    )
    baseline_p99 = baseline_six.p99_ms if baseline_six else float("inf")

    for name in preferred_order:
        cand = candidates.get(name)
        if not cand:
            continue
        six = next((s for s in cand if s.hop_depth == 6), None)
        if six and six.passes_g1():
            return name, (
                f"6-hop P99 dropped from {baseline_p99:.0f}ms (baseline) "
                f"to {six.p99_ms:.0f}ms with {name}, below G1 threshold "
                f"of {G1_P99_THRESHOLD_MS:.0f}ms."
            )

    return None, (
        f"No A–D fix brought 6-hop P99 below {G1_P99_THRESHOLD_MS:.0f}ms. "
        "Per issue #74 acceptance criteria, the production API should be "
        "hard-capped at 4 hops (with a 400 error) and 4-hop P99 < 200ms "
        "must be re-confirmed at 5M blocks before this issue can close."
    )


def run_full_diagnosis(
    conn,
    seed_ids: Sequence[str],
    n_queries: int = 30,
    rng: np.random.Generator | None = None,
    layers: Iterable[str] = _DEFAULT_LAYERS,
    work_mem: str = "256MB",
    topk: int = 5,
    ablation_seed_count: int = 5,
) -> DiagnosticReport:
    """Run the full diagnosis protocol and all four fix candidates.

    Designed for direct invocation from `run_benchmark.py` once a corpus
    has been ingested by `ingest.py`.
    """
    if rng is None:
        rng = np.random.default_rng(42)

    n_blocks = _count(conn, "SELECT COUNT(*) FROM blocks")
    n_links = _count(conn, "SELECT COUNT(*) FROM links")
    seed_ids = list(seed_ids)

    report = DiagnosticReport(
        n_blocks=n_blocks,
        n_links=n_links,
        seed_count=len(seed_ids),
    )

    if not seed_ids:
        report.chosen_fix_rationale = "no seed ids — diagnosis skipped"
        return report

    # Step 1 — explain on a single representative seed
    report.explain_summary = explain_analyze_traversal(
        conn, seed_ids[0], max_depth=6, layers=layers
    )

    # Step 2 — fan-out (cheap, can run on all seeds)
    report.fanout_per_hop = measure_fanout(
        conn, seed_ids, max_depth=6, layers=layers
    )

    # Step 3 — cycle guard ablation on a small sample (no-guard
    # variant can be expensive on cyclic graphs).
    report.cycle_guard_ablation = cycle_guard_ablation(
        conn, seed_ids[:ablation_seed_count], max_depth=6, layers=layers
    )

    # Baseline + each fix
    baseline = bench_baseline(conn, seed_ids, rng, n_queries, layers)
    fix_a = bench_covering_index(conn, seed_ids, rng, n_queries, layers)
    fix_b = bench_work_mem(conn, seed_ids, rng, n_queries, work_mem, layers)
    fix_c = bench_topk_fanout(conn, seed_ids, rng, n_queries, topk, layers)
    fix_d = bench_iterative_bfs(conn, seed_ids, rng, n_queries, layers)

    report.baseline_stats = _stats_to_dict_list(baseline)
    report.fix_a_stats = _stats_to_dict_list(fix_a)
    report.fix_b_stats = _stats_to_dict_list(fix_b)
    report.fix_c_stats = _stats_to_dict_list(fix_c)
    report.fix_d_stats = _stats_to_dict_list(fix_d)

    chosen, rationale = _choose_fix(
        baseline,
        {"fix_a": fix_a, "fix_b": fix_b, "fix_c": fix_c, "fix_d": fix_d},
    )
    report.chosen_fix = chosen
    report.chosen_fix_rationale = rationale

    return report
