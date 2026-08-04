#!/usr/bin/env python3
"""Guarded host-side runner for RC-3 non-Council minutes and votes."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cpu_guard import IngestLock, check_headroom, run_capped
from paths import REPO_ROOT, duckdb_path, raw_dir, receipts_dir


def _table_from_jsonl(connection, name: str, path: Path, empty_schema: str) -> None:
    connection.execute(f"DROP TABLE IF EXISTS {name}")
    if path.exists() and path.stat().st_size:
        connection.execute(
            f"CREATE TABLE {name} AS SELECT * FROM read_json_auto(?, format='newline_delimited')",
            [str(path)],
        )
    else:
        connection.execute(f"CREATE TABLE {name} ({empty_schema})")


def materialize(sources_jsonl: Path, documents_jsonl: Path, matches_jsonl: Path) -> dict:
    import duckdb

    db_path = duckdb_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(db_path))
    try:
        connection.execute("DROP VIEW IF EXISTS non_council_outcomes_by_notice")
        connection.execute("DROP VIEW IF EXISTS non_council_source_coverage_by_body")
        _table_from_jsonl(
            connection,
            "non_council_outcome_sources",
            sources_jsonl,
            "body_id VARCHAR, body_type VARCHAR, borough VARCHAR, district INTEGER, "
            "name VARCHAR, homepage_url VARCHAR, source_url VARCHAR, format VARCHAR, "
            "update_cadence VARCHAR, full_board_votes VARCHAR, status VARCHAR, adapter VARCHAR",
        )
        _table_from_jsonl(
            connection,
            "non_council_outcome_documents",
            documents_jsonl,
            "document_id VARCHAR, body_id VARCHAR, body_type VARCHAR, borough VARCHAR, "
            "meeting_date VARCHAR, title VARCHAR, page_url VARCHAR, document_url VARCHAR, "
            "document_format VARCHAR, observed_at VARCHAR, bytes BIGINT, content_hash VARCHAR, "
            "text_status VARCHAR, text_reason VARCHAR, text_method VARCHAR, text_chars BIGINT, "
            "extracted_text VARCHAR",
        )
        _table_from_jsonl(
            connection,
            "non_council_outcome_matches",
            matches_jsonl,
            "request_id VARCHAR, body_id VARCHAR, borough VARCHAR, meeting_date VARCHAR, "
            'title VARCHAR, outcome JSON, "join" JSON, provenance JSON',
        )
        connection.execute(
            """CREATE VIEW non_council_outcomes_by_notice AS
            SELECT request_id, body_id, meeting_date, title, outcome, provenance
            FROM non_council_outcome_matches"""
        )
        connection.execute(
            """CREATE VIEW non_council_source_coverage_by_body AS
            SELECT s.body_id, s.body_type, s.borough, s.status,
                   count(d.document_id) AS documents_seen,
                   count(d.document_id) FILTER (WHERE d.text_status = 'ok') AS documents_with_text,
                   count(m.request_id) AS notices_matched
            FROM non_council_outcome_sources s
            LEFT JOIN non_council_outcome_documents d ON d.body_id = s.body_id
            LEFT JOIN non_council_outcome_matches m ON m.body_id = s.body_id
            GROUP BY s.body_id, s.body_type, s.borough, s.status"""
        )
    finally:
        connection.close()
    return {
        "database": str(db_path.relative_to(REPO_ROOT)),
        "tables": [
            "non_council_outcome_sources",
            "non_council_outcome_documents",
            "non_council_outcome_matches",
        ],
        "views": [
            "non_council_outcomes_by_notice",
            "non_council_source_coverage_by_body",
        ],
        "single_job_lock": True,
        "headroom_gate": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Guarded non-Council minutes/vote collection")
    parser.add_argument("--from-fixture", action="store_true")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--max-docs", type=int, default=25)
    parser.add_argument("--force-headroom", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.limit <= 64:
        raise SystemExit("--limit must be 1..64")
    if not 1 <= args.max_docs <= 25:
        raise SystemExit("--max-docs must be 1..25")

    with IngestLock():
        check_headroom(force=args.force_headroom or args.from_fixture)
        run_kind = "fixture" if args.from_fixture else "daily"
        output_dir = raw_dir("non-council-outcomes", run_kind)
        sources_jsonl = output_dir / "sources.jsonl"
        documents_jsonl = output_dir / "documents.jsonl"
        matches_jsonl = output_dir / "matches.jsonl"
        payload_path = output_dir / "payload.json"
        receipt_path = receipts_dir() / (
            "proof/rc3_non_council_outcomes_latest.json"
            if args.from_fixture
            else "non_council_outcomes_latest.json"
        )
        command = [
            shutil.which("node") or "node",
            str(REPO_ROOT / "warehouse/scripts/non_council_outcomes.mjs"),
            "--limit",
            str(args.limit),
            "--max-docs",
            str(args.max_docs),
            "--sources-jsonl",
            str(sources_jsonl),
            "--documents-jsonl",
            str(documents_jsonl),
            "--matches-jsonl",
            str(matches_jsonl),
            "--payload",
            str(payload_path),
            "--receipt",
            str(receipt_path),
        ]
        if args.from_fixture:
            command.append("--from-fixture")
        env = os.environ.copy()
        env["CITYSCROLL_WAREHOUSE_PYTHON"] = sys.executable
        if args.from_fixture:
            process = subprocess.run(command, cwd=REPO_ROOT, env=env, check=False)
        else:
            process = run_capped(command, cwd=REPO_ROOT, env=env)
        if process.returncode:
            return process.returncode

        warehouse = materialize(sources_jsonl, documents_jsonl, matches_jsonl)
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["warehouse"] = {
            **warehouse,
            "payload_contract": str(payload_path.relative_to(REPO_ROOT)),
            "taskpolicy_or_nice_wrap": not args.from_fixture,
        }
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
