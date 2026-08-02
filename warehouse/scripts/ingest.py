#!/usr/bin/env python3
"""CPU-capped incremental warehouse ingest skeleton (WH-01).

Examples:
  # Offline proof (no network) — fixture → parquet → DuckDB
  warehouse/.venv/bin/python warehouse/scripts/ingest.py \\
    --dataset ocp-recent-contract-awards --from-fixture --limit 5

  # Tiny live SODA slice (default limit 50)
  warehouse/.venv/bin/python warehouse/scripts/ingest.py \\
    --dataset ocp-recent-contract-awards --limit 50

Never full-blast bulk download here; WH-02 lands full exports under the same caps.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

# Allow `python warehouse/scripts/ingest.py` without installing a package.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from convert_parquet import csv_to_parquet
from cpu_guard import IngestLock, check_headroom, enforce_row_cap, run_capped
from paths import (
    WAREHOUSE_DIR,
    defaults,
    get_dataset,
    parquet_dir,
    raw_dir,
    receipts_dir,
    warehouse_root,
)
from register_duckdb import register_table
from socrata_fetch import fetch_to_file, soda_csv_url, write_json


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot_date_utc() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def fixture_csv(dataset_id: str) -> Path:
    p = WAREHOUSE_DIR / "fixtures" / dataset_id / "sample.csv"
    if not p.is_file():
        raise SystemExit(f"No fixture at {p}")
    return p


def stage_raw_from_fixture(dataset_id: str, snap: str, limit: int) -> dict:
    src = fixture_csv(dataset_id)
    dest_dir = raw_dir(dataset_id, snap)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / "sample.csv"
    # Truncate to limit+header for tiny proof.
    lines = src.read_text(encoding="utf-8").splitlines()
    header, body = lines[0], lines[1:]
    body = body[:limit]
    dest.write_text(header + "\n" + "\n".join(body) + ("\n" if body else ""), encoding="utf-8")
    return {
        "mode": "fixture",
        "source": str(src),
        "path": str(dest),
        "bytes": dest.stat().st_size,
        "row_count": len(body),
        "sha256": sha256_file(dest),
    }


def stage_raw_from_socrata(ds: dict, snap: str, limit: int) -> dict:
    if ds.get("kind") != "socrata":
        raise SystemExit(f"Dataset kind {ds.get('kind')!r} not implemented in WH-01 skeleton")
    url = soda_csv_url(
        ds["domain"],
        ds["dataset_id"],
        limit=limit,
        order="start_date DESC",
    )
    dest = raw_dir(ds["id"], snap) / f"{ds['dataset_id']}_limit{limit}.csv"
    meta = fetch_to_file(url, dest)
    meta["mode"] = "soda_limit"
    meta["sha256"] = sha256_file(dest)
    return meta


def convert_step_simple(csv_path: Path, dataset_id: str, snap: str) -> dict:
    """Single-threaded parquet convert (caller already holds ingest lock + headroom)."""
    out = parquet_dir(dataset_id, snap) / "part-000.parquet"
    return csv_to_parquet(csv_path, out, threads=1)


def main(argv: list[str] | None = None) -> int:
    reg_defaults = defaults()
    p = argparse.ArgumentParser(description="CityScroll warehouse ingest (CPU-capped skeleton)")
    p.add_argument("--dataset", required=True, help="Dataset id from warehouse/datasets.v0.json")
    p.add_argument("--limit", type=int, default=None, help="Max rows (tiny by default)")
    p.add_argument("--from-fixture", action="store_true", help="Use committed fixture (offline proof)")
    p.add_argument("--resume", action="store_true", help="Skip stages whose outputs already exist")
    p.add_argument("--ack-large", action="store_true", help="Acknowledge limit above soft threshold")
    p.add_argument("--force-headroom", action="store_true", help="Bypass headroom gate (tiny proof only)")
    p.add_argument("--snapshot-date", default=None, help="YYYY-MM-DD (default: UTC today)")
    p.add_argument("--skip-register", action="store_true", help="Stop after parquet")
    args = p.parse_args(argv)

    ds = get_dataset(args.dataset)
    limit = args.limit if args.limit is not None else int(ds.get("default_limit") or reg_defaults.get("max_rows_default") or 50)
    limit = enforce_row_cap(limit, reg_defaults, ack_large=args.ack_large)
    snap = args.snapshot_date or snapshot_date_utc()

    print(f"warehouse_root={warehouse_root()}")
    print(f"dataset={ds['id']} limit={limit} snapshot_date={snap} fixture={args.from_fixture}")

    with IngestLock():
        hr = check_headroom(force=args.force_headroom)
        print(f"headroom={hr.get('status')}")

        # --- raw ---
        raw_meta_path = raw_dir(ds["id"], snap) / "raw_meta.json"
        if args.resume and raw_meta_path.is_file():
            raw_meta = json.loads(raw_meta_path.read_text(encoding="utf-8"))
            print(f"raw: resume {raw_meta.get('path')}")
        elif args.from_fixture:
            raw_meta = stage_raw_from_fixture(ds["id"], snap, limit)
            write_json(raw_meta_path, raw_meta)
            print(f"raw: fixture → {raw_meta['path']} rows={raw_meta['row_count']}")
        else:
            raw_meta = stage_raw_from_socrata(ds, snap, limit)
            write_json(raw_meta_path, raw_meta)
            print(f"raw: soda → {raw_meta['path']} rows={raw_meta['row_count']}")

        csv_path = Path(raw_meta["path"])

        # --- parquet (single-threaded; optional outer nice via run_capped for heavy live jobs) ---
        pq_dir = parquet_dir(ds["id"], snap)
        pq_path = pq_dir / "part-000.parquet"
        pq_meta_path = pq_dir / "parquet_meta.json"
        if args.resume and pq_path.is_file() and pq_meta_path.is_file():
            pq_meta = json.loads(pq_meta_path.read_text(encoding="utf-8"))
            print(f"parquet: resume {pq_meta.get('parquet_path')}")
        else:
            # Prefer wrapped subprocess for live downloads (CPU yield); fixtures stay in-process.
            if args.from_fixture:
                pq_meta = convert_step_simple(csv_path, ds["id"], snap)
            else:
                helper = Path(__file__).resolve().parent / "_convert_main.py"
                proc = run_capped(
                    [
                        sys.executable,
                        str(helper),
                        "--csv",
                        str(csv_path),
                        "--parquet",
                        str(pq_path),
                        "--threads",
                        "1",
                        "--meta-out",
                        str(pq_meta_path),
                    ]
                )
                if proc.returncode != 0:
                    # Fallback in-process if wrap/helper fails
                    print("parquet: wrap convert failed, falling back in-process", file=sys.stderr)
                    pq_meta = convert_step_simple(csv_path, ds["id"], snap)
                else:
                    pq_meta = json.loads(pq_meta_path.read_text(encoding="utf-8"))
            write_json(pq_meta_path, pq_meta)
            print(f"parquet: {pq_meta['parquet_path']} rows={pq_meta['row_count']}")

        if args.skip_register:
            receipt = _write_receipt(ds, snap, limit, raw_meta, pq_meta, register_meta=None)
            print(f"receipt={receipt} (register skipped)")
            return 0

        # --- DuckDB catalog ---
        glob = str(pq_dir / "*.parquet")
        reg_meta = register_table(ds["table_name"], glob)
        print(f"duckdb: {reg_meta['catalog']} view={reg_meta['table']} rows={reg_meta['row_count']}")

        receipt = _write_receipt(ds, snap, limit, raw_meta, pq_meta, reg_meta)
        print(f"receipt={receipt}")
        print("OK")
        return 0


def _write_receipt(ds, snap, limit, raw_meta, pq_meta, register_meta) -> Path:
    receipt = {
        "schema_version": 1,
        "phase": "WH-01",
        "dataset_id": ds["id"],
        "source_contract_id": ds.get("source_contract_id"),
        "table_name": ds.get("table_name"),
        "snapshot_date": snap,
        "limit": limit,
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "warehouse_root": str(warehouse_root()),
        "raw": raw_meta,
        "parquet": pq_meta,
        "register": register_meta,
        "cpu_discipline": {
            "single_job_lock": True,
            "duckdb_threads": 1,
            "headroom_gated": True,
            "taskpolicy_or_nice_wrap": True,
        },
    }
    out = receipts_dir() / f"{ds['id']}_{snap}.json"
    write_json(out, receipt)
    # Also copy a small proof receipt into the committed tree when using fixtures
    # under the default in-repo root (gitignored bulk dirs stay out of git).
    proof = WAREHOUSE_DIR / "receipts" / "proof" / f"{ds['id']}_latest.json"
    if raw_meta.get("mode") == "fixture":
        proof.parent.mkdir(parents=True, exist_ok=True)
        # Strip absolute machine paths for a portable proof artifact.
        portable = json.loads(json.dumps(receipt))
        root_s = str(warehouse_root())
        wh_s = str(WAREHOUSE_DIR)

        def port(s: str) -> str:
            return s.replace(root_s, "warehouse").replace(wh_s, "warehouse")

        if isinstance(portable.get("warehouse_root"), str):
            portable["warehouse_root"] = port(portable["warehouse_root"])
        for key in ("raw", "parquet", "register"):
            block = portable.get(key) or {}
            for pk in ("path", "parquet_path", "catalog", "source", "parquet_glob"):
                if pk in block and isinstance(block[pk], str):
                    block[pk] = port(block[pk])
        write_json(proof, portable)
    return out


if __name__ == "__main__":
    raise SystemExit(main())
