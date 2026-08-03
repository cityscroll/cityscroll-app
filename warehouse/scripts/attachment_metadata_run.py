#!/usr/bin/env python3
"""CPU-capped, incremental T0 attachment-metadata runner."""

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


def materialize(jsonl: Path) -> None:
    import duckdb

    db_path = duckdb_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(db_path))
    try:
        connection.execute("DROP VIEW IF EXISTS attachment_metadata_by_notice")
        connection.execute("DROP TABLE IF EXISTS attachment_metadata")
        if jsonl.stat().st_size:
            connection.execute(
                "CREATE TABLE attachment_metadata AS SELECT * FROM read_json_auto(?)",
                [str(jsonl)],
            )
        else:
            connection.execute("""CREATE TABLE attachment_metadata (
                request_id VARCHAR, document_id VARCHAR, title VARCHAR, url VARCHAR,
                content_type VARCHAR, bytes BIGINT, source VARCHAR)""")
        connection.execute("""CREATE VIEW attachment_metadata_by_notice AS
            SELECT request_id, count(*) AS n_attachments,
                   list(struct_pack(document_id := document_id, title := title, url := url,
                                    content_type := content_type, bytes := bytes, source := source)
                        ORDER BY document_id) AS attachments
            FROM attachment_metadata GROUP BY request_id""")
    finally:
        connection.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Guarded T0 attachment metadata batch")
    parser.add_argument("--from-fixture", action="store_true")
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--historical-titles", action="store_true")
    parser.add_argument("--force-headroom", action="store_true")
    parser.add_argument("--push-url", default=os.environ.get("CITYSCROLL_ATTACHMENT_ENDPOINT"))
    args = parser.parse_args(argv)
    if not 1 <= args.limit <= 1000:
        raise SystemExit("--limit must be 1..1000")

    with IngestLock():
        check_headroom(force=args.force_headroom or (args.from_fixture and args.limit <= 100))
        jsonl = raw_dir("attachment-metadata", args.end_date or "daily") / "attachments.jsonl"
        receipt = receipts_dir() / ("proof/att01_attachment_metadata_latest.json" if args.from_fixture else "attachment_metadata_latest.json")
        command = [shutil.which("node") or "node", str(REPO_ROOT / "warehouse/scripts/attachment_metadata.mjs"),
                   "--limit", str(args.limit), "--jsonl", str(jsonl), "--receipt", str(receipt)]
        if args.from_fixture:
            command.append("--from-fixture")
        if args.start_date:
            command.extend(["--start-date", args.start_date])
        if args.end_date:
            command.extend(["--end-date", args.end_date])
        if args.historical_titles:
            command.append("--historical-titles")
        if args.push_url:
            command.extend(["--push-url", args.push_url])
        if args.from_fixture and args.limit <= 100:
            process = subprocess.run(command, cwd=REPO_ROOT, check=False)
        else:
            process = run_capped(command, cwd=REPO_ROOT)
        if process.returncode:
            return process.returncode
        materialize(jsonl)
        payload = json.loads(receipt.read_text(encoding="utf-8"))
        payload["warehouse"] = {
            "table": "attachment_metadata",
            "materialized_view": "attachment_metadata_by_notice",
            "single_job_lock": True,
            "headroom_gate": True,
            "taskpolicy_or_nice_wrap": not (args.from_fixture and args.limit <= 100),
        }
        receipt.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
