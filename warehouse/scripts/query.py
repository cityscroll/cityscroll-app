#!/usr/bin/env python3
"""DuckDB SQL query seam — offline SQL over warehouse views.

Examples:
  warehouse/.venv/bin/python warehouse/scripts/query.py \\
    --sql "SELECT COUNT(*) AS n FROM ocp_recent_contract_awards"

  warehouse/.venv/bin/python warehouse/scripts/query.py \\
    --sql-file warehouse/sql/examples/ocp_awards_by_agency.sql
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from register_duckdb import run_sql


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Query CityScroll DuckDB warehouse catalog")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--sql", help="SQL string")
    g.add_argument("--sql-file", type=Path, help="Path to .sql file")
    p.add_argument("--format", choices=("json", "table"), default="json")
    args = p.parse_args(argv)

    sql = args.sql if args.sql else args.sql_file.read_text(encoding="utf-8")
    rows = run_sql(sql)
    if args.format == "json":
        print(json.dumps(rows, indent=2, default=str))
    else:
        if not rows:
            print("(0 rows)")
            return 0
        cols = list(rows[0].keys())
        print("\t".join(cols))
        for r in rows:
            print("\t".join(str(r.get(c, "")) for c in cols))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
