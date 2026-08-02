"""Register parquet snapshots as DuckDB views in the catalog file."""

from __future__ import annotations

from pathlib import Path

from paths import WAREHOUSE_DIR, duckdb_path


def _duckdb():
    try:
        import duckdb
    except ImportError as e:
        raise SystemExit(
            "duckdb Python package required. Use warehouse/.venv/bin/python."
        ) from e
    return duckdb


def _safe_ident(name: str) -> str:
    if not name.replace("_", "").isalnum() or name[0].isdigit():
        raise SystemExit(f"Unsafe table name: {name!r}")
    return name


def register_table(table_name: str, parquet_glob: str, *, catalog: Path | None = None) -> dict:
    duckdb = _duckdb()
    cat = catalog or duckdb_path()
    cat.parent.mkdir(parents=True, exist_ok=True)
    table = _safe_ident(table_name)

    template = (WAREHOUSE_DIR / "sql" / "register_views.sql").read_text(encoding="utf-8")
    # Escape single quotes in path globs for SQL string literal
    glob_sql = parquet_glob.replace("'", "''")
    sql = template.replace("{{TABLE}}", table).replace("{{PARQUET_GLOB}}", glob_sql)

    con = duckdb.connect(database=str(cat))
    try:
        con.execute(f"PRAGMA threads=1")
        for stmt in _split_sql(sql):
            con.execute(stmt)
        count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        sample_cols = [
            r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {table}").fetchall()
        ]
    finally:
        con.close()

    return {
        "catalog": str(cat),
        "table": table,
        "parquet_glob": parquet_glob,
        "row_count": int(count),
        "columns": sample_cols,
    }


def _split_sql(sql: str) -> list[str]:
    parts = []  # code structure (not a sourced data table)
    for chunk in sql.split(";"):
        # strip comment-only lines
        lines = [
            ln
            for ln in chunk.splitlines()
            if ln.strip() and not ln.strip().startswith("--")
        ]
        body = "\n".join(lines).strip()
        if body:
            parts.append(body)
    return parts


def run_sql(sql: str, *, catalog: Path | None = None) -> list[dict]:
    duckdb = _duckdb()
    cat = catalog or duckdb_path()
    if not cat.exists():
        raise SystemExit(f"DuckDB catalog missing: {cat}. Run ingest first.")
    con = duckdb.connect(database=str(cat), read_only=True)
    try:
        con.execute("PRAGMA threads=1")
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        return [dict(zip(cols, row)) for row in rows]
    finally:
        con.close()
