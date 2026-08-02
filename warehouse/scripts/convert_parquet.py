"""raw CSV → parquet via DuckDB (single-threaded friendly defaults).

Optional column_map renames bulk-export PascalCase headers to SODA fieldNames
so warehouse tables match product joins (agency_name, pin, …).
"""

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


def _sql_ident(name: str) -> str:
    """Double-quote a column identifier for DuckDB."""
    return '"' + name.replace('"', '""') + '"'


def _sql_alias(name: str) -> str:
    """Safe unquoted alias when snake_case; else quote."""
    if name.replace("_", "").isalnum() and not name[0].isdigit():
        return name
    return _sql_ident(name)


def build_select_list(csv_columns: list[str], column_map: dict[str, str] | None) -> str:
    """SELECT list: apply column_map (source header → target name) when present."""
    if not column_map:
        return "*"
    # Map by exact header; leave unmapped columns as-is (quoted).
    parts = []
    for col in csv_columns:
        target = column_map.get(col) or column_map.get(col.strip())
        if target and target != col:
            parts.append(f"{_sql_ident(col)} AS {_sql_alias(target)}")
        else:
            parts.append(_sql_ident(col))
    return ", ".join(parts)


def read_csv_header(csv_path: Path) -> list[str]:
    import csv

    with csv_path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f)
        row = next(reader, None)
        return list(row) if row else []


def csv_to_parquet(
    csv_path: Path,
    parquet_path: Path,
    *,
    threads: int = 1,
    column_map: dict[str, str] | None = None,
) -> dict:
    duckdb = _duckdb()
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    if parquet_path.exists():
        parquet_path.unlink()

    csv_lit = _sql_str(csv_path)
    pq_lit = _sql_str(parquet_path)

    headers = read_csv_header(csv_path)
    select_list = build_select_list(headers, column_map)

    con = duckdb.connect(database=":memory:")
    try:
        con.execute(f"PRAGMA threads={int(threads)}")
        # COPY through DuckDB; path literals (params for COPY TO are finicky).
        con.execute(
            f"""
            COPY (
              SELECT {select_list}
              FROM read_csv_auto({csv_lit}, header=true, sample_size=-1)
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
        "column_map_applied": bool(column_map),
        "column_map_size": len(column_map) if column_map else 0,
    }
