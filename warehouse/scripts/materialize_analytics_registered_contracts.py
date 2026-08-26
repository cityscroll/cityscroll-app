#!/usr/bin/env python3
"""Materialize the precomputed analytical projection in the warehouse catalog."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from paths import duckdb_path  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path("site/data/analytics_registered_contracts.json"))
    parser.add_argument("--catalog", type=Path, default=None)
    args = parser.parse_args()
    try:
        import duckdb
    except ImportError as exc:
        raise SystemExit("duckdb Python package required. Use warehouse/.venv/bin/python.") from exc
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise SystemExit("projection input must contain rows[]")
    ids = [row.get("prime_contract_id") for row in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("projection contains duplicate prime_contract_id values")
    catalog = args.catalog or duckdb_path()
    catalog.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(catalog))
    try:
        connection.execute("PRAGMA threads=1")
        connection.execute("DROP TABLE IF EXISTS analytics_registered_contracts")
        connection.execute(
            """CREATE TABLE analytics_registered_contracts (
                prime_contract_id VARCHAR PRIMARY KEY,
                agency VARCHAR,
                prime_vendor VARCHAR,
                registration_date DATE,
                registration_fiscal_year INTEGER,
                contract_amount_band VARCHAR,
                award_method VARCHAR,
                current_registered_amount DOUBLE,
                original_registered_amount DOUBLE,
                source_fiscal_years VARCHAR[],
                source VARCHAR
            )"""
        )
        connection.executemany(
            """INSERT INTO analytics_registered_contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    row.get("prime_contract_id"), row.get("agency"), row.get("prime_vendor"),
                    row.get("registration_date"), row.get("registration_fiscal_year"),
                    row.get("contract_amount_band"), row.get("award_method"),
                    row.get("current_registered_amount"), row.get("original_registered_amount"),
                    row.get("source_fiscal_years") or [], row.get("source"),
                )
                for row in rows
            ],
        )
        count = connection.execute("SELECT COUNT(*) FROM analytics_registered_contracts").fetchone()[0]
        print(json.dumps({"table": "analytics_registered_contracts", "row_count": count, "catalog": str(catalog)}))
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
