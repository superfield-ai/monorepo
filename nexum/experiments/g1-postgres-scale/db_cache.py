"""
db_cache.py — Local dump/restore cache for the G1 benchmark database.

Dumps are stored in ~/.cache/nexum/ (never inside the repo) so they are
never committed to git.  Each dump is named by scale + embedding dimension
so multiple fixtures can coexist.

Usage::

    # Create a dump of the current database state
    python db_cache.py dump \\
        --docker-container nexum-bench \\
        --db-url postgresql://nexum:nexum@localhost:5433/nexum_bench \\
        --scale 1m --dim 384

    # Restore from cache (drops + recreates the target database)
    python db_cache.py restore \\
        --docker-container nexum-bench \\
        --scale 1m --dim 384

    # List available cached dumps
    python db_cache.py list

Dump format: pg_dump custom format (-Fc), written directly to the cache dir.
Restore uses pg_restore via docker exec (preserves pg16 compatibility).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


CACHE_DIR = Path.home() / ".cache" / "nexum"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ── naming ────────────────────────────────────────────────────────────────────

def _dump_name(scale: str, dim: int) -> str:
    return f"nexum_bench_{scale.lower()}_{dim}dim.dump"


def _meta_name(scale: str, dim: int) -> str:
    return f"nexum_bench_{scale.lower()}_{dim}dim.meta.json"


def _dump_path(scale: str, dim: int) -> Path:
    return CACHE_DIR / _dump_name(scale, dim)


def _meta_path(scale: str, dim: int) -> Path:
    return CACHE_DIR / _meta_name(scale, dim)


# ── docker helpers ────────────────────────────────────────────────────────────

def _docker_exec(container: str, cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "exec", container] + cmd, **kwargs)


def _detect_pgvector_version(container: str, db_url: str) -> str:
    """Read pgvector version from the running container."""
    import psycopg2
    try:
        conn = psycopg2.connect(db_url)
        with conn.cursor() as cur:
            cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
            row = cur.fetchone()
        conn.close()
        return row[0] if row else "unknown"
    except Exception:
        return "unknown"


def _detect_n_blocks(db_url: str) -> int:
    import psycopg2
    conn = psycopg2.connect(db_url)
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM blocks")
        n = cur.fetchone()[0]
    conn.close()
    return n


# ── dump ──────────────────────────────────────────────────────────────────────

def cmd_dump(args: argparse.Namespace) -> int:
    out = _dump_path(args.scale, args.dim)
    meta = _meta_path(args.scale, args.dim)

    if out.exists() and not args.force:
        size_mb = out.stat().st_size / 1024**2
        print(f"[CACHE] Dump already exists: {out} ({size_mb:.0f} MB)")
        print("[CACHE] Use --force to overwrite.")
        return 0

    # Parse db name from URL for pg_dump
    db_name = args.db_url.rstrip("/").split("/")[-1]
    db_user = args.db_url.split("://")[1].split(":")[0]

    print(f"[CACHE] Dumping {db_name} → {out} …")
    print(f"[CACHE] (This may take several minutes for large datasets)")

    t0 = time.perf_counter()
    tmp = out.with_suffix(".dump.tmp")

    # pg_dump custom format piped from docker exec to local file
    proc = subprocess.Popen(
        ["docker", "exec", args.docker_container,
         "pg_dump", "-U", db_user, "-Fc", "--no-privileges", db_name],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    dump_bytes, stderr = proc.communicate()

    if proc.returncode != 0:
        print(f"[CACHE] ERROR: pg_dump failed:\n{stderr.decode()}", file=sys.stderr)
        return 1

    tmp.write_bytes(dump_bytes)
    tmp.rename(out)

    elapsed = time.perf_counter() - t0
    size_mb = out.stat().st_size / 1024**2
    print(f"[CACHE] Dump complete: {size_mb:.0f} MB in {elapsed:.0f}s")

    # Write metadata sidecar
    pgvec = _detect_pgvector_version(args.docker_container, args.db_url)
    try:
        n_blocks = _detect_n_blocks(args.db_url)
    except Exception:
        n_blocks = None

    meta_data = {
        "scale": args.scale,
        "dim": args.dim,
        "n_blocks": n_blocks,
        "pgvector_version": pgvec,
        "docker_container": args.docker_container,
        "db_url_template": args.db_url,
        "dump_file": str(out),
        "dump_size_mb": round(size_mb, 1),
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    meta.write_text(json.dumps(meta_data, indent=2))
    print(f"[CACHE] Metadata written to {meta}")
    print(f"[CACHE] Restore with: python db_cache.py restore --scale {args.scale} --dim {args.dim}")

    return 0


# ── restore ───────────────────────────────────────────────────────────────────

def cmd_restore(args: argparse.Namespace) -> int:
    dump = _dump_path(args.scale, args.dim)
    meta = _meta_path(args.scale, args.dim)

    if not dump.exists():
        print(f"[CACHE] ERROR: No dump found at {dump}", file=sys.stderr)
        print(f"[CACHE] Run: python db_cache.py dump --scale {args.scale} --dim {args.dim}")
        return 1

    size_mb = dump.stat().st_size / 1024**2
    if meta.exists():
        info = json.loads(meta.read_text())
        print(f"[CACHE] Found dump: {size_mb:.0f} MB, created {info.get('created_at','?')}, "
              f"n_blocks={info.get('n_blocks','?')}, pgvector={info.get('pgvector_version','?')}")
    else:
        print(f"[CACHE] Found dump: {size_mb:.0f} MB (no metadata)")

    db_name = args.db_url.rstrip("/").split("/")[-1]
    db_user = args.db_url.split("://")[1].split(":")[0]

    # Drop and recreate the target database
    print(f"[CACHE] Dropping {db_name} …")
    _docker_exec(args.docker_container, ["dropdb", "-U", db_user, "--if-exists", db_name])

    print(f"[CACHE] Creating {db_name} …")
    r = _docker_exec(args.docker_container, ["createdb", "-U", db_user, db_name])
    if r.returncode != 0:
        print("[CACHE] ERROR: createdb failed", file=sys.stderr)
        return 1

    # Copy dump into container and restore
    container_tmp = f"/tmp/{dump.name}"
    print(f"[CACHE] Copying dump into container …")
    r = subprocess.run(["docker", "cp", str(dump), f"{args.docker_container}:{container_tmp}"])
    if r.returncode != 0:
        print("[CACHE] ERROR: docker cp failed", file=sys.stderr)
        return 1

    print(f"[CACHE] Restoring {size_mb:.0f} MB dump → {db_name} …")
    t0 = time.perf_counter()
    r = _docker_exec(
        args.docker_container,
        ["pg_restore", "-U", db_user, "-d", db_name,
         "--no-privileges", "--no-owner", "-j", str(args.jobs),
         container_tmp],
    )
    elapsed = time.perf_counter() - t0

    # pg_restore exits 1 on warnings (e.g. already-exists); check stderr too
    if r.returncode not in (0, 1):
        print(f"[CACHE] ERROR: pg_restore failed (exit {r.returncode})", file=sys.stderr)
        return 1

    print(f"[CACHE] Restore complete in {elapsed:.0f}s")

    # Cleanup temp file in container
    _docker_exec(args.docker_container, ["rm", "-f", container_tmp])

    return 0


# ── list ──────────────────────────────────────────────────────────────────────

def cmd_list(_args: argparse.Namespace) -> int:
    dumps = sorted(CACHE_DIR.glob("*.dump"))
    if not dumps:
        print(f"[CACHE] No dumps in {CACHE_DIR}")
        return 0

    print(f"[CACHE] Cached dumps in {CACHE_DIR}:")
    for d in dumps:
        meta_file = d.with_suffix("").with_suffix(".meta.json")
        size_mb = d.stat().st_size / 1024**2
        if meta_file.exists():
            info = json.loads(meta_file.read_text())
            print(f"  {d.name}  {size_mb:.0f} MB  "
                  f"n_blocks={info.get('n_blocks','?')}  "
                  f"pgvector={info.get('pgvector_version','?')}  "
                  f"created={info.get('created_at','?')[:10]}")
        else:
            print(f"  {d.name}  {size_mb:.0f} MB  (no metadata)")
    return 0


# ── main ─────────────────────────────────────────────────────────────────────

def _common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--docker-container", default="nexum-bench")
    p.add_argument("--db-url", default="postgresql://nexum:nexum@localhost:5433/nexum_bench")
    p.add_argument("--scale", default="1m", help="Scale label, e.g. 1m, 5m (default: 1m)")
    p.add_argument("--dim", type=int, default=384, help="Embedding dimension (default: 384)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="G1 benchmark DB dump/restore cache")
    sub = parser.add_subparsers(dest="command", required=True)

    p_dump = sub.add_parser("dump", help="Dump current database to cache")
    _common_args(p_dump)
    p_dump.add_argument("--force", action="store_true", help="Overwrite existing dump")

    p_restore = sub.add_parser("restore", help="Restore database from cache")
    _common_args(p_restore)
    p_restore.add_argument("--jobs", type=int, default=4,
                           help="Parallel restore jobs (default: 4)")

    p_list = sub.add_parser("list", help="List cached dumps")

    args = parser.parse_args(argv)
    dispatch = {"dump": cmd_dump, "restore": cmd_restore, "list": cmd_list}
    return dispatch[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
