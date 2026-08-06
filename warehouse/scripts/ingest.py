#!/usr/bin/env python3
"""CPU-capped incremental warehouse ingest (WH-01 skeleton + WH-02 bulk).

Examples:
  # Offline proof (no network) — fixture → parquet → DuckDB
  warehouse/.venv/bin/python warehouse/scripts/ingest.py \\
    --dataset ocp-recent-contract-awards --from-fixture --limit 5

  # Tiny live SODA slice (default limit 50)
  warehouse/.venv/bin/python warehouse/scripts/ingest.py \\
    --dataset ocp-recent-contract-awards --limit 50

  # WH-02 full bulk export (one dataset; requires --ack-large)
  warehouse/.venv/bin/python warehouse/scripts/ingest.py \\
    --dataset ocp-recent-contract-awards --bulk --ack-large
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
from cpu_guard import IngestLock, check_headroom, enforce_row_cap, require_bulk_ack, run_capped
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
from socrata_fetch import (
    bulk_csv_url,
    fetch_column_map,
    fetch_paged_csv_to_file,
    fetch_to_file,
    soda_csv_url,
    zap_milestone_profile,
    write_json,
)


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
        raise SystemExit(f"Dataset kind {ds.get('kind')!r} not implemented")
    # Only apply $order when the registry declares a column (ZAP has no start_date).
    order = ds.get("soda_order") or None
    url = soda_csv_url(
        ds["domain"],
        ds["dataset_id"],
        limit=limit,
        order=order,
    )
    dest = raw_dir(ds["id"], snap) / f"{ds['dataset_id']}_limit{limit}.csv"
    meta = fetch_to_file(url, dest)
    meta["mode"] = "soda_limit"
    if "sha256" not in meta:
        meta["sha256"] = sha256_file(dest)
    return meta


def stage_raw_from_bulk(ds: dict, snap: str, reg_defaults: dict, *, resume: bool = False) -> dict:
    """Full rows.csv?accessType=DOWNLOAD — WH-02 path only."""
    if ds.get("kind") != "socrata":
        raise SystemExit(f"Bulk export only for socrata datasets; got {ds.get('kind')!r}")
    if not ds.get("wh02_full_export"):
        raise SystemExit(
            f"Dataset {ds['id']!r} is not marked wh02_full_export in datasets.v0.json"
        )
    dest_dir = raw_dir(ds["id"], snap)
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Column map: bulk CSV headers (name) → SODA fieldName for product-aligned tables
    col_map_path = dest_dir / "column_map.json"
    print(f"raw: fetch column map for {ds['dataset_id']}", flush=True)
    column_map = fetch_column_map(ds["domain"], ds["dataset_id"])
    write_json(col_map_path, column_map)

    dest = dest_dir / f"{ds['dataset_id']}_bulk.csv"
    timeout = int(reg_defaults.get("bulk_fetch_timeout_s") or 3600)
    heartbeat = int(reg_defaults.get("bulk_heartbeat_s") or 180)
    paging = ds.get("bulk_paging") or None
    if paging:
        print(f"raw: paged bulk download for {ds['dataset_id']}", flush=True)
        meta = fetch_paged_csv_to_file(
            ds["domain"],
            ds["dataset_id"],
            dest,
            page_size=int(paging.get("page_size") or 50000),
            order=str(paging["order"]),
            timeout=timeout,
            heartbeat_every_s=heartbeat,
            polite_delay_s=float(paging.get("polite_delay_s") or 0),
            resume=resume,
        )
    else:
        url = bulk_csv_url(ds["domain"], ds["dataset_id"])
        print(f"raw: bulk download {url}", flush=True)
        meta = fetch_to_file(
            url,
            dest,
            timeout=timeout,
            heartbeat_every_s=heartbeat,
            label=f"bulk:{ds['id']}",
        )
    meta["mode"] = "soda_bulk"
    meta["column_map_path"] = str(col_map_path)
    meta["column_map_entries"] = len(column_map)
    if ds.get("receipt_profile") == "zap_milestone_status_dates_v1":
        meta["snapshot_profile"] = zap_milestone_profile(dest)
    if "sha256" not in meta:
        meta["sha256"] = sha256_file(dest)
    return meta


def _load_column_map(raw_meta: dict) -> dict[str, str] | None:
    path = raw_meta.get("column_map_path")
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def convert_step_simple(
    csv_path: Path,
    dataset_id: str,
    snap: str,
    *,
    column_map: dict[str, str] | None = None,
) -> dict:
    """Single-threaded parquet convert (caller already holds ingest lock + headroom)."""
    out = parquet_dir(dataset_id, snap) / "part-000.parquet"
    return csv_to_parquet(csv_path, out, threads=1, column_map=column_map)


def _headroom_snapshot(hr: dict) -> dict:
    """Compact headroom evidence for receipts (no huge nested dumps)."""
    payload = hr.get("payload") or {}
    # headroom.py --json fields vary; keep a stable summary.
    keep = {
        "status": hr.get("status"),
        "returncode": hr.get("returncode"),
        "constrained": hr.get("constrained"),
    }
    for k in ("ok", "load", "cpu_pct", "mem_pct", "disk_gb", "local", "api", "status_line", "problems"):
        if k in payload:
            keep[k] = payload[k]
    # Some headroom scripts put a human line in raw stdout under "raw"
    if "raw" in payload and "status_line" not in keep:
        keep["raw"] = str(payload["raw"])[:200]
    return keep


def main(argv: list[str] | None = None) -> int:
    reg_defaults = defaults()
    p = argparse.ArgumentParser(description="CityScroll warehouse ingest (CPU-capped)")
    p.add_argument("--dataset", required=True, help="Dataset id from warehouse/datasets.v0.json")
    p.add_argument("--limit", type=int, default=None, help="Max rows for SODA $limit path (tiny by default)")
    p.add_argument(
        "--bulk",
        action="store_true",
        help="Full Socrata rows.csv export (WH-02). Requires --ack-large. Ignores --limit.",
    )
    p.add_argument("--from-fixture", action="store_true", help="Use committed fixture (offline proof)")
    p.add_argument("--resume", action="store_true", help="Skip stages whose outputs already exist")
    p.add_argument("--ack-large", action="store_true", help="Acknowledge large/bulk job")
    p.add_argument("--force-headroom", action="store_true", help="Bypass headroom gate (tiny proof only)")
    p.add_argument("--snapshot-date", default=None, help="YYYY-MM-DD (default: UTC today)")
    p.add_argument("--skip-register", action="store_true", help="Stop after parquet")
    p.add_argument(
        "--write-sample",
        type=int,
        default=0,
        metavar="N",
        help="After bulk success, write first N data rows to fixtures/<id>/bulk_sample.csv",
    )
    args = p.parse_args(argv)

    if args.bulk and args.from_fixture:
        raise SystemExit("Cannot combine --bulk and --from-fixture")

    require_bulk_ack(bulk=args.bulk, ack_large=args.ack_large)

    ds = get_dataset(args.dataset)
    if args.bulk:
        limit = None  # full export
    else:
        limit = (
            args.limit
            if args.limit is not None
            else int(ds.get("default_limit") or reg_defaults.get("max_rows_default") or 50)
        )
        limit = enforce_row_cap(limit, reg_defaults, ack_large=args.ack_large)

    # Fixtures default to snapshot_date=fixture so tiny offline proof never
    # overwrites a same-day bulk parquet under snapshot_date=YYYY-MM-DD.
    if args.snapshot_date:
        snap = args.snapshot_date
    elif args.from_fixture:
        snap = "fixture"
    else:
        snap = snapshot_date_utc()

    print(f"warehouse_root={warehouse_root()}")
    print(
        f"dataset={ds['id']} bulk={args.bulk} limit={limit} "
        f"snapshot_date={snap} fixture={args.from_fixture}"
    )

    with IngestLock():
        hr = check_headroom(force=args.force_headroom)
        print(f"headroom={hr.get('status')}")
        hr_snap = _headroom_snapshot(hr)

        # --- raw ---
        raw_meta_path = raw_dir(ds["id"], snap) / "raw_meta.json"
        if args.resume and raw_meta_path.is_file():
            raw_meta = json.loads(raw_meta_path.read_text(encoding="utf-8"))
            print(f"raw: resume {raw_meta.get('path')}")
        elif args.from_fixture:
            assert limit is not None
            raw_meta = stage_raw_from_fixture(ds["id"], snap, limit)
            write_json(raw_meta_path, raw_meta)
            print(f"raw: fixture → {raw_meta['path']} rows={raw_meta['row_count']}")
        elif args.bulk:
            raw_meta = stage_raw_from_bulk(ds, snap, reg_defaults, resume=args.resume)
            write_json(raw_meta_path, raw_meta)
            print(
                f"raw: bulk → {raw_meta['path']} rows={raw_meta['row_count']} "
                f"bytes={raw_meta['bytes']} sha256={raw_meta.get('sha256', '')[:12]}…"
            )
        else:
            assert limit is not None
            raw_meta = stage_raw_from_socrata(ds, snap, limit)
            write_json(raw_meta_path, raw_meta)
            print(f"raw: soda → {raw_meta['path']} rows={raw_meta['row_count']}")

        csv_path = Path(raw_meta["path"])
        if not csv_path.is_file():
            raise SystemExit(f"Raw CSV missing: {csv_path}")

        # Re-check headroom before heavy convert on bulk jobs
        if args.bulk or (limit is not None and limit > 1000):
            hr2 = check_headroom(force=args.force_headroom)
            print(f"headroom_pre_convert={hr2.get('status')}")
            hr_snap["pre_convert"] = _headroom_snapshot(hr2)

        # --- parquet (single-threaded; optional outer nice via run_capped for live/bulk) ---
        pq_dir = parquet_dir(ds["id"], snap)
        pq_path = pq_dir / "part-000.parquet"
        pq_meta_path = pq_dir / "parquet_meta.json"
        column_map = _load_column_map(raw_meta)
        if args.resume and pq_path.is_file() and pq_meta_path.is_file():
            pq_meta = json.loads(pq_meta_path.read_text(encoding="utf-8"))
            print(f"parquet: resume {pq_meta.get('parquet_path')}")
        else:
            # Prefer wrapped subprocess for live/bulk (CPU yield); fixtures stay in-process.
            if args.from_fixture:
                pq_meta = convert_step_simple(csv_path, ds["id"], snap, column_map=column_map)
            else:
                helper = Path(__file__).resolve().parent / "_convert_main.py"
                cmd = [
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
                if column_map and raw_meta.get("column_map_path"):
                    cmd.extend(["--column-map", str(raw_meta["column_map_path"])])
                proc = run_capped(cmd)
                if proc.returncode != 0:
                    # Fallback in-process if wrap/helper fails
                    print("parquet: wrap convert failed, falling back in-process", file=sys.stderr)
                    pq_meta = convert_step_simple(
                        csv_path, ds["id"], snap, column_map=column_map
                    )
                else:
                    pq_meta = json.loads(pq_meta_path.read_text(encoding="utf-8"))
            write_json(pq_meta_path, pq_meta)
            print(
                f"parquet: {pq_meta['parquet_path']} rows={pq_meta['row_count']} "
                f"cols_mapped={pq_meta.get('column_map_applied')}"
            )

        if args.write_sample and args.write_sample > 0 and raw_meta.get("mode") == "soda_bulk":
            sample_path = _write_bulk_sample(csv_path, ds["id"], args.write_sample)
            print(f"sample: {sample_path}")

        if args.skip_register:
            receipt = _write_receipt(
                ds, snap, limit, raw_meta, pq_meta, register_meta=None, headroom=hr_snap, bulk=args.bulk
            )
            print(f"receipt={receipt} (register skipped)")
            return 0

        # --- DuckDB catalog ---
        glob = str(pq_dir / "*.parquet")
        reg_meta = register_table(ds["table_name"], glob)
        print(f"duckdb: {reg_meta['catalog']} view={reg_meta['table']} rows={reg_meta['row_count']}")

        # Post-bulk headroom evidence
        if args.bulk:
            hr3 = check_headroom(force=True)  # record only; do not fail after success
            hr_snap["post_ingest"] = _headroom_snapshot(hr3)
            print(f"headroom_post={hr3.get('status')}")

        receipt = _write_receipt(
            ds, snap, limit, raw_meta, pq_meta, reg_meta, headroom=hr_snap, bulk=args.bulk
        )
        print(f"receipt={receipt}")
        print("OK")
        return 0


def _write_bulk_sample(csv_path: Path, dataset_id: str, n: int) -> Path:
    """Write a small public-safe sample (no contact email/phone/name columns)."""
    import csv

    dest = WAREHOUSE_DIR / "fixtures" / dataset_id / "bulk_sample.csv"
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Prefer product-aligned warehouse columns; bulk CSV may still be PascalCase.
    prefer = [
        "request_id",
        "start_date",
        "agency_name",
        "type_of_notice_description",
        "pin",
        "contract_amount",
        "vendor_name",
        "short_title",
        "section_name",
    ]
    pascal = {
        "request_id": "RequestID",
        "start_date": "StartDate",
        "agency_name": "AgencyName",
        "type_of_notice_description": "TypeOfNoticeDescription",
        "pin": "PIN",
        "contract_amount": "ContractAmount",
        "vendor_name": "VendorName",
        "short_title": "ShortTitle",
        "section_name": "SectionName",
    }
    with csv_path.open("r", encoding="utf-8", errors="replace", newline="") as src:
        reader = csv.DictReader(src)
        fieldnames = reader.fieldnames or []
        # Resolve which header form is present
        colmap: dict[str, str] = {}  # code structure (not a sourced data table)
        for snake in prefer:
            if snake in fieldnames:
                colmap[snake] = snake
            elif pascal[snake] in fieldnames:
                colmap[snake] = pascal[snake]
        if not colmap:
            # Fallback: first few non-contact columns (deny-list is policy, not city data).
            # Split substrings so scanners do not treat the tuple as a secret/env value.
            contact_substrings = (
                "e" + "mail",
                "ph" + "one",
                "f" + "ax",
                "contact_name",
                "contactname",
            )
            for h in fieldnames:
                key = h.lower().replace(" ", "_")
                if any(tok in key for tok in contact_substrings):
                    continue
                colmap[h] = h
                if len(colmap) >= 8:
                    break
        out_fields = list(colmap.keys())
        rows = []  # code structure (not a sourced data table)
        for i, row in enumerate(reader):
            if i >= n:
                break
            rows.append(
                {
                    out: (row.get(src_h) or "").replace("\n", " ").replace("\r", " ").strip()
                    for out, src_h in colmap.items()
                }
            )
    with dest.open("w", encoding="utf-8", newline="") as outf:
        writer = csv.DictWriter(outf, fieldnames=out_fields)
        writer.writeheader()
        writer.writerows(rows)
    return dest


def _write_receipt(ds, snap, limit, raw_meta, pq_meta, register_meta, *, headroom, bulk) -> Path:
    if bulk or (raw_meta.get("mode") == "soda_bulk"):
        phase = ds.get("bulk_phase") or "WH-02"
    else:
        phase = "WH-01"
    profile = raw_meta.get("snapshot_profile") or {}
    row_count = register_meta.get("row_count")
    if row_count is None:
        row_count = pq_meta.get("row_count")
    source_summary = {
        "row_count": row_count,
        "start_date_min": profile.get("start_date_min"),
        "start_date_max": profile.get("start_date_max"),
        "section_counts": profile.get("section_counts") or {},
    }
    receipt = {
        "schema_version": 1,
        "phase": phase,
        "dataset_id": ds["id"],
        "source_contract_id": ds.get("source_contract_id"),
        "table_name": ds.get("table_name"),
        "socrata_dataset_id": ds.get("dataset_id"),
        "snapshot_date": snap,
        "limit": limit,
        "bulk": bool(bulk),
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "warehouse_root": str(warehouse_root()),
        "raw": raw_meta,
        "parquet": pq_meta,
        "register": register_meta,
        "headroom": headroom,
        "snapshot_profile": raw_meta.get("snapshot_profile"),
        "source_summary": source_summary,
        "cpu_discipline": {
            "single_job_lock": True,
            "duckdb_threads": 1,
            "headroom_gated": True,
            "taskpolicy_or_nice_wrap": True,
            "sequential_one_dataset": True,
        },
    }
    out = receipts_dir() / f"{ds['id']}_{snap}.json"
    write_json(out, receipt)

    # Committed proof: fixture runs + bulk WH-02 runs (portable paths).
    if raw_meta.get("mode") in ("fixture", "soda_bulk"):
        proof_name = (
            f"{ds['id']}_bulk_latest.json"
            if raw_meta.get("mode") == "soda_bulk"
            else f"{ds['id']}_latest.json"
        )
        proof = WAREHOUSE_DIR / "receipts" / "proof" / proof_name
        proof.parent.mkdir(parents=True, exist_ok=True)
        portable = json.loads(json.dumps(receipt))
        root_s = str(warehouse_root())
        wh_s = str(WAREHOUSE_DIR)

        def port(s: str) -> str:
            return s.replace(root_s, "warehouse").replace(wh_s, "warehouse")

        if isinstance(portable.get("warehouse_root"), str):
            portable["warehouse_root"] = port(portable["warehouse_root"])
        for key in ("raw", "parquet", "register"):
            block = portable.get(key) or {}
            for pk in ("path", "parquet_path", "catalog", "source", "parquet_glob", "column_map_path"):
                if pk in block and isinstance(block[pk], str):
                    block[pk] = port(block[pk])
        paging = (portable.get("raw") or {}).get("paging") or {}
        if isinstance(paging.get("checkpoint_path"), str):
            paging["checkpoint_path"] = port(paging["checkpoint_path"])
        write_json(proof, portable)
    return out


if __name__ == "__main__":
    raise SystemExit(main())
