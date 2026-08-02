"""raw CSV → parquet via DuckDB (single-threaded friendly defaults)."""

from __future__ import annotations

from pathlib import Path


def _duckdb():
    try:
        import duckdb
    except ImportError as e:
        raise SystemExit(
            "duckdb Python package required. Create the warehouse venv:\n"
            "  python3 -m venv warehouse/.venv\n"
            "  warehouse/.venv/bin/pip install -r warehouse/requirements.txt\n"
            "Then re-run with warehouse/.venv/bin/python …"
        ) from e
    return duckdb


def _sql_str(path: Path | str) -> str:
    """Single-quote a filesystem path for DuckDB SQL (escape embedded quotes)."""
    s = str(path)
    return "'" + s.replace("'", "''") + "'"


def csv_to_parquet(csv_path: Path, parquet_path: Path, *, threads: int = 1) -> dict:
    duckdb = _duckdb()
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    if parquet_path.exists():
        parquet_path.unlink()

    csv_lit = _sql_str(csv_path)
    pq_lit = _sql_str(parquet_path)

    con = duckdb.connect(database=":memory:")
    try:
        con.execute(f"PRAGMA threads={int(threads)}")
        # COPY through DuckDB; path literals (params for COPY TO are finicky).
        con.execute(
            f"""
            COPY (
              SELECT * FROM read_csv_auto({csv_lit}, header=true, sample_size=-1)
            ) TO {pq_lit} (FORMAT PARQUET, COMPRESSION ZSTD)
            """
        )
        row_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet({pq_lit})"
        ).fetchone()[0]
        cols = [
            r[0]
            for r in con.execute(
                f"DESCRIBE SELECT * FROM read_parquet({pq_lit})"
            ).fetchall()
        ]
    finally:
        con.close()

    return {
        "parquet_path": str(parquet_path),
        "bytes": parquet_path.stat().st_size,
        "row_count": int(row_count),
        "columns": cols,
        "threads": threads,
    }
