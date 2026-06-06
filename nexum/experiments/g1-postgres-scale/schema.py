"""
schema.py — Nexum schema loader for the G1 benchmark.

Applies the Nexum DDL (db/schema.sql) to the target database. Idempotent: all
statements use IF NOT EXISTS so running twice is safe.
"""

from __future__ import annotations

import os
import re


_DEFAULT_SCHEMA_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "db", "schema.sql"
)


def ensure_schema(conn, schema_sql_path: str = _DEFAULT_SCHEMA_PATH) -> None:
    """Apply the Nexum schema to the connected database.

    Reads *schema_sql_path* and executes every statement it contains.  The
    schema uses ``IF NOT EXISTS`` throughout, so this function is idempotent —
    calling it on a database that already has the schema is a no-op.

    Args:
        conn: An open psycopg2 connection.  The caller owns the connection
              lifecycle (open / close / transaction management).
        schema_sql_path: Path to the Nexum ``db/schema.sql`` file.  Defaults
                         to ``../../db/schema.sql`` relative to this module.

    Raises:
        FileNotFoundError: If *schema_sql_path* does not exist.
        psycopg2.DatabaseError: On any SQL execution error.
    """
    schema_sql_path = os.path.abspath(schema_sql_path)
    if not os.path.exists(schema_sql_path):
        raise FileNotFoundError(
            f"Schema file not found: {schema_sql_path}\n"
            "Ensure you are running from the experiments/g1-postgres-scale/ "
            "directory or pass an explicit path."
        )

    with open(schema_sql_path, "r", encoding="utf-8") as fh:
        sql = fh.read()

    # Split on statement boundaries.  We handle:
    #   1. Dollar-quoted DO blocks  (DO $$ … $$;)
    #   2. Normal semicolon-terminated statements
    # Strategy: split naively on ";\n" then stitch back dollar-quoted blocks.
    statements = _split_statements(sql)

    with conn.cursor() as cur:
        for stmt in statements:
            stmt = stmt.strip()
            if not stmt:
                continue
            # Strip leading comment lines so multi-line statements that begin
            # with a `-- comment` are not skipped by the `startswith('--')`
            # heuristic. (Bug discovered while diagnosing issue #73 — the
            # `CREATE TABLE blocks` and `DROP/CREATE INDEX ... hnsw` blocks
            # were being silently dropped because their first line was a
            # comment, leaving the benchmark with no HNSW index and a
            # parallel-seq-scan ANN path.)
            executable = "\n".join(
                line for line in stmt.splitlines()
                if line.strip() and not line.strip().startswith("--")
            ).strip()
            if not executable:
                continue
            cur.execute(stmt)

    conn.commit()

    # Defensive check: the HNSW index is the contract surface tested by the
    # G1 gate (issue #73). If it's missing after schema apply, the loader
    # has silently dropped a statement and downstream benchmarks will
    # report sequential-scan latency as if it were ANN performance.
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM pg_class WHERE relname = 'blocks_embedding_hnsw_idx' "
            "AND relkind = 'i'"
        )
        if cur.fetchone() is None:
            raise RuntimeError(
                "schema apply did not create blocks_embedding_hnsw_idx — "
                "ANN benchmarks would fall back to sequential scan. See "
                "experiments/g1-postgres-scale/results/postgres_config.md."
            )


def _split_statements(sql: str) -> list[str]:
    """Split a SQL script into individual statements.

    Handles dollar-quoted blocks (``DO $$ … $$``) by treating them as a single
    statement regardless of semicolons inside the block.
    """
    statements: list[str] = []
    current: list[str] = []
    in_dollar_quote = False
    dollar_tag = ""

    # Tokenise line-by-line; good enough for our schema (no inline $$ strings
    # inside regular SELECT statements).
    for line in sql.splitlines(keepends=True):
        stripped = line.strip()

        if not in_dollar_quote:
            # Detect opening dollar-quote tag (e.g. $$, $body$, $func$).
            # Matches both DO $$ ... $$ anonymous blocks and
            # CREATE OR REPLACE FUNCTION ... AS $$ ... $$ named function bodies.
            match = re.search(r"\$([^$]*)\$", stripped)
            _upper = stripped.upper()
            if match and ("DO" in _upper or "AS" in _upper or "LANGUAGE" in _upper):
                in_dollar_quote = True
                dollar_tag = match.group(0)  # e.g. "$$" or "$body$"
                current.append(line)
                continue

        if in_dollar_quote:
            current.append(line)
            # Detect closing dollar-quote
            if dollar_tag in stripped and stripped.endswith(";"):
                statements.append("".join(current))
                current = []
                in_dollar_quote = False
                dollar_tag = ""
            continue

        # Normal line — check for statement terminator
        current.append(line)
        if stripped.endswith(";"):
            statements.append("".join(current))
            current = []

    # Flush any trailing content (no trailing semicolon)
    if current:
        tail = "".join(current).strip()
        if tail:
            statements.append(tail)

    return statements
