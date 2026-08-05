#!/usr/bin/env python3
"""CPU-capped, incremental T1 attachment inline-text runner."""

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


def latest_t0_inventory() -> Path:
    receipt = receipts_dir() / "attachment_metadata_latest.json"
    try:
        payload = json.loads(receipt.read_text(encoding="utf-8"))
        inventory = payload.get("inventory")
        if inventory:
            return REPO_ROOT / inventory
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return REPO_ROOT / "warehouse/raw/attachment-metadata/attachments.jsonl"


def materialize(jsonl: Path) -> dict:
    try:
        import duckdb
    except ImportError:
        return {"skipped": True, "reason": "duckdb_unavailable"}

    db_path = duckdb_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(db_path))
    try:
        connection.execute("DROP VIEW IF EXISTS attachment_text_by_notice")
        connection.execute("DROP TABLE IF EXISTS attachment_text")
        if jsonl.exists() and jsonl.stat().st_size:
            connection.execute(
                "CREATE TABLE attachment_text AS SELECT * FROM read_json_auto(?)",
                [str(jsonl)],
            )
        else:
            connection.execute(
                """CREATE TABLE attachment_text (
                request_id VARCHAR, document_id VARCHAR, title VARCHAR, url VARCHAR,
                content_type VARCHAR, bytes BIGINT, source VARCHAR,
                text_status VARCHAR, text_reason VARCHAR, text_method VARCHAR,
                text_chars BIGINT, text_preview VARCHAR, extracted_text VARCHAR,
                text_extracted_at VARCHAR)"""
            )
        connection.execute(
            """CREATE VIEW attachment_text_by_notice AS
            SELECT request_id, count(*) AS n_attachments,
                   count(*) FILTER (WHERE text_status = 'ok') AS n_with_text,
                   list(struct_pack(
                        document_id := document_id, title := title, url := url,
                        content_type := content_type, bytes := bytes, source := source,
                        text_status := text_status, text_preview := text_preview,
                        text_chars := text_chars, text_method := text_method)
                        ORDER BY document_id) AS attachments
            FROM attachment_text GROUP BY request_id"""
        )
    finally:
        connection.close()
    return {
        "table": "attachment_text",
        "materialized_view": "attachment_text_by_notice",
        "single_job_lock": True,
        "headroom_gate": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Guarded T1 attachment inline-text batch")
    parser.add_argument("--from-fixture", action="store_true")
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--force-headroom", action="store_true")
    parser.add_argument("--push-url", default=os.environ.get("CITYSCROLL_ATTACHMENT_ENDPOINT"))
    parser.add_argument("--inventory", default=None)
    args = parser.parse_args(argv)
    if not 1 <= args.limit <= 25:
        raise SystemExit("--limit must be 1..25")

    with IngestLock():
        check_headroom(force=args.force_headroom or (args.from_fixture and args.limit <= 25))
        jsonl = raw_dir("attachment-text", "daily") / "attachments_with_text.jsonl"
        receipt = receipts_dir() / (
            "proof/att_t1_attachment_text_latest.json"
            if args.from_fixture
            else "attachment_text_latest.json"
        )
        command = [
            shutil.which("node") or "node",
            str(REPO_ROOT / "warehouse/scripts/attachment_text.mjs"),
            "--limit",
            str(args.limit),
            "--jsonl",
            str(jsonl),
            "--receipt",
            str(receipt),
        ]
        if args.from_fixture:
            command.append("--from-fixture")
        inventory = Path(args.inventory) if args.inventory else latest_t0_inventory()
        command.extend(["--inventory", str(inventory)])
        if args.push_url:
            command.extend(["--push-url", args.push_url])
        if args.from_fixture and args.limit <= 25:
            process = subprocess.run(command, cwd=REPO_ROOT, check=False)
        else:
            process = run_capped(command, cwd=REPO_ROOT)
        if process.returncode:
            return process.returncode
        warehouse_info = materialize(jsonl)
        payload = json.loads(receipt.read_text(encoding="utf-8"))
        payload["warehouse"] = {
            **warehouse_info,
            "taskpolicy_or_nice_wrap": not (args.from_fixture and args.limit <= 25),
        }
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
