#!/usr/bin/env python3
"""Write / update the committed WH-02 load manifest from proof receipts + headroom.

Does not embed multi-MB raw data — only checksums, counts, and queue status.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from paths import WAREHOUSE_DIR, load_registry


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Write WH-02 load manifest")
    p.add_argument(
        "--out",
        type=Path,
        default=WAREHOUSE_DIR / "manifests" / "wh02_load_manifest.json",
    )
    p.add_argument(
        "--headroom-line",
        default="",
        help="Human headroom one-liner captured at pack time",
    )
    args = p.parse_args(argv)

    reg = load_registry()
    pack = reg.get("wh02_pack") or {}
    queue = list(pack.get("queue") or [])

    proof_dir = WAREHOUSE_DIR / "receipts" / "proof"
    loaded = []
    for ds_id in queue:
        bulk_proof = proof_dir / f"{ds_id}_bulk_latest.json"
        if not bulk_proof.is_file():
            continue
        r = json.loads(bulk_proof.read_text(encoding="utf-8"))
        raw = r.get("raw") or {}
        pq = r.get("parquet") or {}
        regm = r.get("register") or {}
        loaded.append(
            {
                "dataset_id": ds_id,
                "socrata_dataset_id": r.get("socrata_dataset_id"),
                "table_name": r.get("table_name"),
                "snapshot_date": r.get("snapshot_date"),
                "observed_at": r.get("observed_at"),
                "mode": raw.get("mode"),
                "row_count": regm.get("row_count") or pq.get("row_count") or raw.get("row_count"),
                "raw_bytes": raw.get("bytes"),
                "raw_sha256": raw.get("sha256"),
                "parquet_bytes": pq.get("bytes"),
                "parquet_row_count": pq.get("row_count"),
                "headroom": r.get("headroom"),
                "proof_receipt": f"warehouse/receipts/proof/{ds_id}_bulk_latest.json",
                "verify_sql": (
                    "warehouse/sql/examples/ocp_bulk_verify.sql"
                    if ds_id == "ocp-recent-contract-awards"
                    else None
                ),
            }
        )

    loaded_ids = {x["dataset_id"] for x in loaded}
    remaining = [d for d in queue if d not in loaded_ids]
    # Also note registry datasets with wh02_full_export not on primary queue
    optional = []
    for ds_id, ds in (reg.get("datasets") or {}).items():
        if ds.get("wh02_full_export") and ds_id not in queue and ds_id not in loaded_ids:
            optional.append(ds_id)

    manifest = {
        "schema_version": 1,
        "phase": "WH-02",
        "title": "First bulk pack into the warehouse (CPU-capped, incremental)",
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "strategy": pack.get("strategy"),
        "first_pick": pack.get("first_pick"),
        "first_pick_rationale": pack.get("first_pick_rationale"),
        "cpu_discipline": {
            "runner": "warehouse/scripts/ingest.py --bulk --ack-large",
            "single_job_lock": True,
            "headroom_gate": True,
            "taskpolicy_or_nice_wrap": True,
            "duckdb_threads": 1,
            "sequential": True,
            "no_parallel_downloads": True,
        },
        "git_policy": {
            "commit_raw_bulk": False,
            "commit_parquet_bulk": False,
            "commit_duckdb_catalog": False,
            "commit_proof_receipts": True,
            "commit_manifest_checksums": True,
            "commit_small_samples": True,
            "note": "Bulk lives under warehouse/raw|parquet|duckdb (gitignored) or CITYSCROLL_WAREHOUSE_ROOT",
        },
        "headroom_evidence_line": args.headroom_line or None,
        "loaded": loaded,
        "remaining_primary_queue": remaining,
        "optional_later": optional,
        "next_dataset": remaining[0] if remaining else None,
        "next_dataset_notes": (
            "zap-projects (hgx4-8ukb, ~33k rows) for WH-03 prewarm — only when headroom stays green"
            if remaining and remaining[0] == "zap-projects"
            else pack.get("deferred_notes")
        ),
        "how_to_reproduce": [
            "python3 ~/dev/agentic-engineering-principles/bin/headroom.py  # must not be CONSTRAINED",
            "python3 -m venv warehouse/.venv && warehouse/.venv/bin/pip install -r warehouse/requirements.txt",
            "warehouse/.venv/bin/python warehouse/scripts/ingest.py --dataset ocp-recent-contract-awards --bulk --ack-large --write-sample 25",
            "warehouse/.venv/bin/python warehouse/scripts/query.py --sql-file warehouse/sql/examples/ocp_bulk_verify.sql",
            "warehouse/.venv/bin/python warehouse/scripts/write_load_manifest.py",
        ],
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {args.out} loaded={len(loaded)} remaining={remaining}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
