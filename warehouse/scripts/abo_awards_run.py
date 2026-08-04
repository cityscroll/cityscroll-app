#!/usr/bin/env python3
"""Guarded RC-4 ABO residual collector + DuckDB materialization."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cpu_guard import IngestLock, check_headroom, run_capped
from paths import REPO_ROOT, duckdb_path, raw_dir, receipts_dir


TABLES = (
    ("notices.jsonl", "abo_residual_notice"),
    ("awards.jsonl", "abo_procurement_award"),
    ("candidates.jsonl", "abo_residual_candidate"),
    ("matches.jsonl", "abo_residual_match"),
    ("measurement.jsonl", "abo_residual_measurement"),
)


def materialize(stage_dir: Path) -> dict:
    import duckdb

    catalog = duckdb_path()
    catalog.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(catalog))
    results = []
    try:
        connection.execute("PRAGMA threads=1")
        for filename, table in TABLES:
            source = stage_dir / filename
            if not source.is_file():
                raise SystemExit(f"missing ABO stage file: {source}")
            if source.stat().st_size:
                connection.execute(
                    f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM read_json_auto(?)",
                    [str(source)],
                )
            elif table == "abo_residual_match":
                connection.execute(
                    """CREATE OR REPLACE TABLE abo_residual_match AS
                       SELECT CAST(NULL AS VARCHAR) AS request_id,
                              CAST(NULL AS VARCHAR) AS source_key,
                              CAST(NULL AS VARCHAR) AS method,
                              CAST(NULL AS DOUBLE) AS confidence,
                              CAST(NULL AS JSON) AS award
                       WHERE 1=0"""
                )
            else:
                raise SystemExit(f"unexpected empty ABO stage file: {source}")
            count = int(connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
            columns = [row[0] for row in connection.execute(f"DESCRIBE {table}").fetchall()]
            results.append({"table": table, "row_count": count, "columns": columns})
    finally:
        connection.close()
    return {
        "catalog": "warehouse/duckdb/cityscroll.duckdb",
        "tables": results,
        "duckdb_threads": 1,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Guarded RC-4 ABO residual measurement")
    parser.add_argument("--from-fixture", action="store_true")
    parser.add_argument("--force-headroom", action="store_true")
    parser.add_argument("--polite-delay-ms", type=int, default=300)
    parser.add_argument("--stage-dir", type=Path)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--skip-materialize", action="store_true")
    args = parser.parse_args(argv)

    if not args.from_fixture and args.polite_delay_ms < 250:
        raise SystemExit("--polite-delay-ms must be at least 250 for live collection")

    stage_dir = args.stage_dir or raw_dir("abo-awards-residual", "fixture" if args.from_fixture else "latest")
    receipt = receipts_dir() / (
        "proof/abo_residual_2026-08-04.json" if args.from_fixture else "abo_residual_latest.json"
    )
    public_receipt = REPO_ROOT / "site/data/abo_award_sources/verification_receipts/abo_residual_2026-08-04.json"
    payload = REPO_ROOT / "site/data/abo_award_residual_lookup.json"
    worker_payload = REPO_ROOT / "worker/src/data/abo_award_residual_lookup.json"

    with IngestLock():
        check_headroom(force=args.force_headroom or args.from_fixture)
        command = [
            shutil.which("node") or "node",
            str(REPO_ROOT / "warehouse/scripts/abo_awards.mjs"),
            "--stage-dir",
            str(stage_dir),
            "--receipt",
            str(receipt),
            "--payload",
            str(payload),
            "--worker-payload",
            str(worker_payload),
            "--polite-delay-ms",
            str(args.polite_delay_ms),
        ]
        if args.from_fixture:
            command.append("--from-fixture")
        if args.checkpoint:
            command.extend(["--checkpoint", str(args.checkpoint)])

        if args.from_fixture:
            process = subprocess.run(command, cwd=REPO_ROOT, check=False)
        else:
            process = run_capped(command, cwd=REPO_ROOT)
        if process.returncode:
            return process.returncode

        warehouse = None if args.skip_materialize else materialize(stage_dir)
        receipt_body = json.loads(receipt.read_text(encoding="utf-8"))
        receipt_body["warehouse"] = {
            **(warehouse or {"skipped": True}),
            "single_job_lock": True,
            "headroom_gate": True,
            "taskpolicy_or_nice_wrap": not args.from_fixture,
        }
        rendered = json.dumps(receipt_body, indent=2) + "\n"
        receipt.write_text(rendered, encoding="utf-8")
        if args.from_fixture:
            public_receipt.parent.mkdir(parents=True, exist_ok=True)
            public_receipt.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
