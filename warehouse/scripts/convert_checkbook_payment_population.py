#!/usr/bin/env python3
"""Convert the independent Checkbook payment CSV to Parquet and reconcile it."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from convert_parquet import csv_to_parquet


def _duckdb():
    try:
        import duckdb
    except ImportError as exc:
        raise SystemExit("duckdb Python package required; use warehouse/.venv/bin/python") from exc
    return duckdb


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--source-receipt", type=Path, help="collector receipt containing expected XML/normalized totals")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    if not args.csv.is_file():
        raise SystemExit(f"CSV not found: {args.csv}")
    converted = csv_to_parquet(args.csv, args.parquet, threads=1)
    duckdb = _duckdb()
    con = duckdb.connect(database=":memory:")
    try:
        path = str(args.parquet).replace("'", "''")
        row_count, net_amount = con.execute(
            f"SELECT COUNT(*), ROUND(COALESCE(SUM(check_amount), 0), 2) FROM read_parquet('{path}')"
        ).fetchone()
    finally:
        con.close()
    source_receipt = None
    expected_count = converted["row_count"]
    expected_amount = float(net_amount)
    if args.source_receipt:
        source_receipt = json.loads(args.source_receipt.read_text(encoding="utf-8"))
        expected_count = int(source_receipt["population"]["normalized_rows"])
        expected_amount = float(source_receipt["reconciliation"]["normalized_net_check_amount"])
    count_matches = int(row_count) == expected_count
    amount_matches = round(float(net_amount), 2) == round(expected_amount, 2)
    receipt = {
        "schema": "cityscroll.checkbook_payment_population_conversion_receipt.v1",
        "source_csv": {"path": str(args.csv), "row_count": converted["row_count"]},
        "parquet": {**converted, "row_count": int(row_count), "net_check_amount": float(net_amount)},
        "source_receipt": str(args.source_receipt) if args.source_receipt else None,
        "reconciliation": {
            "expected_source_row_count": expected_count,
            "expected_source_net_check_amount": expected_amount,
            "count_matches": count_matches,
            "amount_matches": amount_matches,
            "amount_from_parquet": float(net_amount),
        },
        "query_proof": "SELECT agency, COUNT(*) AS transaction_count, ROUND(SUM(check_amount), 2) AS net_check_amount FROM checkbook_payment_population GROUP BY agency ORDER BY net_check_amount DESC",
    }
    receipt["reconciliation"]["reconciled"] = count_matches and amount_matches
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["reconciliation"]["reconciled"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
