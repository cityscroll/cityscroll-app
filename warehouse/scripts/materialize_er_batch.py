#!/usr/bin/env python3
"""Materialize WH-04 ER batch JSONL → parquet + DuckDB views.

Called by warehouse/scripts/er_batch.mjs after the Node identity pass.
DuckDB threads=1 (CPU discipline).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from paths import WAREHOUSE_DIR, duckdb_path, warehouse_root


TABLES = (
    ("entity_link", "er_entity_link"),
    ("canonical_entity", "er_canonical_entity"),
    ("resolution_run", "er_resolution_run"),
    ("pair_receipt", "er_pair_receipt"),
)


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


def materialize(stage_dir: Path, snapshot_date: str) -> dict:
    duckdb = _duckdb()
    root = warehouse_root()
    cat = duckdb_path()
    cat.parent.mkdir(parents=True, exist_ok=True)

    results = []  # code structure (not a sourced data table)
    con = duckdb.connect(database=str(cat))
    try:
        con.execute("PRAGMA threads=1")
        for file_stem, view_name in TABLES:
            jsonl = stage_dir / f"{file_stem}.jsonl"
            if not jsonl.is_file():
                raise SystemExit(f"Missing stage file: {jsonl}")
            # Empty JSONL → empty table with no columns is awkward; write a
            # one-row placeholder schema from an empty list via read_json with
            # columns when file is empty.
            text = jsonl.read_text(encoding="utf-8").strip()
            out_dir = (
                root
                / "parquet"
                / view_name
                / f"snapshot_date={snapshot_date}"
            )
            out_dir.mkdir(parents=True, exist_ok=True)
            parquet_path = out_dir / "part-000.parquet"
            view = _safe_ident(view_name)
            glob = str(
                root / "parquet" / view_name / "snapshot_date=*" / "part-*.parquet"
            ).replace("'", "''")
            pq_sql = str(parquet_path).replace("'", "''")
            jsonl_sql = str(jsonl).replace("'", "''")

            if not text:
                # Zero rows: still create an empty parquet with a stub schema
                # so the view registers.
                con.execute(
                    f"""
                    COPY (
                      SELECT
                        CAST(NULL AS VARCHAR) AS id,
                        CAST(NULL AS VARCHAR) AS placeholder
                      WHERE 1=0
                    ) TO '{pq_sql}' (FORMAT PARQUET)
                    """
                )
                row_count = 0
            else:
                con.execute(
                    f"""
                    COPY (
                      SELECT * FROM read_json_auto('{jsonl_sql}', format='newline_delimited')
                    ) TO '{pq_sql}' (FORMAT PARQUET)
                    """
                )
                row_count = int(
                    con.execute(
                        f"SELECT COUNT(*) FROM read_parquet('{pq_sql}')"
                    ).fetchone()[0]
                )

            con.execute(
                f"CREATE OR REPLACE VIEW {view} AS "
                f"SELECT * FROM read_parquet('{glob}')"
            )
            # Prefer repo-relative paths in receipts (scrim / public surface).
            try:
                pq_report = str(parquet_path.relative_to(WAREHOUSE_DIR.parent))
            except ValueError:
                pq_report = str(parquet_path)
            results.append(
                {
                    "view": view,
                    "parquet": pq_report,
                    "row_count": row_count,
                }
            )

        # Convenience join view: OCP awards → vendor entity (when awards exist).
        try:
            con.execute("SELECT 1 FROM ocp_recent_contract_awards LIMIT 1")
            has_ocp = True
        except Exception:
            has_ocp = False

        if has_ocp:
            con.execute(
                """
                CREATE OR REPLACE VIEW er_ocp_vendor_resolved AS
                SELECT
                  a.request_id,
                  a.pin,
                  a.agency_name,
                  a.vendor_name,
                  a.contract_amount,
                  a.start_date,
                  l.canonical_entity_id,
                  l.method AS link_method,
                  l.confidence AS link_confidence,
                  l.decision AS link_decision,
                  e.display_name AS entity_display_name,
                  e.entity_type
                FROM ocp_recent_contract_awards a
                LEFT JOIN er_entity_link l
                  ON l.source_record_id = 'ocp-recent-contract-awards:'
                    || CAST(a.request_id AS VARCHAR)
                 AND l.entity_type = 'vendor'
                 AND l.decision = 'auto_link'
                LEFT JOIN er_canonical_entity e
                  ON e.id = l.canonical_entity_id
                """
            )
            results.append({"view": "er_ocp_vendor_resolved", "join": True})
    finally:
        con.close()

    try:
        cat_report = str(cat.relative_to(WAREHOUSE_DIR.parent))
    except ValueError:
        cat_report = str(cat)
    return {
        "catalog": cat_report,
        "snapshot_date": snapshot_date,
        "tables": results,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Materialize WH-04 ER batch to parquet/DuckDB")
    p.add_argument("--stage-dir", type=Path, required=True)
    p.add_argument("--snapshot-date", required=True)
    args = p.parse_args(argv)
    if not args.stage_dir.is_dir():
        raise SystemExit(f"stage dir missing: {args.stage_dir}")
    out = materialize(args.stage_dir, args.snapshot_date)
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
