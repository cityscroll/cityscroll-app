#!/usr/bin/env python3
"""Build the bounded DYCD agency program-sites artifact.

Reads the retained fiscal-year Queens fixture (raw rows plus capture receipt
and publisher metadata), reduces it with ``warehouse/lib/dycd_program_sites``
and publishes ``site/data/agency_program_sites.json`` with per-district
shards under ``site/data/agency_program_sites/``. Every shard holds at most
500 rows and 512 KiB; the manifest stays under 64 KiB. A capture that fails
validation never replaces accepted data. ``--check`` rebuilds in memory and
compares against the committed artifacts without writing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "warehouse/lib"))

from dycd_program_sites import program_map  # noqa: E402

SCHEMA = "cityscroll.agency_program_sites.v1"
AGENCY_ID = "youth-and-community-development"
SOURCE_ID = "dycd-program-sites"
DATASET_ID = "ebkm-iyma"
FISCAL_YEAR = 2026

MANIFEST_MAX_BYTES = 65536
SHARD_MAX_BYTES = 524288
ROWS_PER_SHARD = 500
FISCAL_YEAR_ROW_CAP = 10000
TEXT_FIELD_CAPS = {
    "provider": 300,
    "program_type": 300,
    "program_area": 300,
    "site_name": 300,
    "street_address": 500,
}


def _json_bytes(obj: dict) -> bytes:
    return (json.dumps(obj, indent=1, sort_keys=True) + "\n").encode("utf-8")


def _row(member: dict) -> dict:
    row = {
        "id": f"source:{SOURCE_ID}:{member['id']}",
        "agency_id": AGENCY_ID,
        "fiscal_year": FISCAL_YEAR,
        "provider": member["provider"],
        "program_type": member["program_type"],
        "program_area": member.get("program_area"),
        "site_name": member["program_site_name"],
        "street_address": member.get("street_address"),
        "geography_key": member["geography_key"],
        "place_role": "facility_site",
        "relation": "located_in",
        "basis": "publisher_explicit_communitydistrict",
        "contract_raw": member.get("contract"),
        "portfolio_id_raw": member.get("portfolioid"),
        "source_rows": member["source_rows"],
    }
    for field, cap in TEXT_FIELD_CAPS.items():
        value = row.get(field)
        if isinstance(value, str) and len(value) > cap:
            raise SystemExit(f"row {row['id']} field {field} exceeds {cap} characters")
    return row


def build(fixture_dir: Path) -> dict:
    raw_path = fixture_dir / f"dycd-queens-fy{FISCAL_YEAR}.raw.json"
    receipt = json.loads((fixture_dir / "capture-receipt.json").read_text(encoding="utf-8"))
    metadata = json.loads((fixture_dir / f"{DATASET_ID}-metadata.json").read_text(encoding="utf-8"))
    raw_bytes = raw_path.read_bytes()
    rows = json.loads(raw_bytes.decode("utf-8"))

    if not receipt.get("complete"):
        raise SystemExit("capture receipt is not complete; accepted data must be retained")
    if int(receipt.get("rows", -1)) != len(rows):
        raise SystemExit(
            f"capture receipt count {receipt.get('rows')} does not match {len(rows)} raw rows"
        )
    if len(rows) > FISCAL_YEAR_ROW_CAP:
        raise SystemExit(f"fiscal-year rows exceed {FISCAL_YEAR_ROW_CAP} bound")
    if hashlib.sha256(raw_bytes).hexdigest() != receipt.get("sha256"):
        raise SystemExit("raw fixture hash does not match capture receipt")

    result = program_map(rows, complete=True, fy=FISCAL_YEAR)
    if result["status"] != "available":
        raise SystemExit("program-site reduction is unavailable for a complete capture")

    publisher_updated_at = None
    if metadata.get("rowsUpdatedAt") is not None:
        publisher_updated_at = datetime.fromtimestamp(
            int(metadata["rowsUpdatedAt"]), tz=timezone.utc
        ).isoformat()

    members_by_district: dict[str, list[dict]] = {}
    for member in result["members"]:
        members_by_district.setdefault(member["geography_key"], []).append(_row(member))

    shards = []
    shard_bodies: dict[str, bytes] = {}
    for geography_key in sorted(members_by_district):
        district = geography_key.rsplit(":", 1)[1]
        district_rows = sorted(members_by_district[geography_key], key=lambda r: r["id"])
        for page in range(0, max(1, (len(district_rows) + ROWS_PER_SHARD - 1) // ROWS_PER_SHARD)):
            chunk = district_rows[page * ROWS_PER_SHARD : (page + 1) * ROWS_PER_SHARD]
            shard_id = f"dycd-fy{FISCAL_YEAR}-{district}-p{page:03d}"
            body = {
                "schema": SCHEMA,
                "id": shard_id,
                "agency_id": AGENCY_ID,
                "fiscal_year": FISCAL_YEAR,
                "district": district,
                "page": page,
                "rows": chunk,
            }
            payload = _json_bytes(body)
            if len(payload) > SHARD_MAX_BYTES:
                raise SystemExit(f"shard {shard_id} exceeds {SHARD_MAX_BYTES} bytes")
            shards.append(
                {
                    "id": shard_id,
                    "path": f"agency_program_sites/{shard_id}.json",
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "bytes": len(payload),
                    "row_count": len(chunk),
                    "agency_id": AGENCY_ID,
                    "fiscal_year": FISCAL_YEAR,
                    "district": district,
                    "page": page,
                }
            )
            shard_bodies[f"{shard_id}.json"] = payload

    manifest = {
        "schema": SCHEMA,
        "generated_at": receipt["captured_at"],
        "source_id": SOURCE_ID,
        "dataset_id": DATASET_ID,
        "publisher_updated_at": publisher_updated_at,
        "checked_at": receipt["captured_at"],
        "fiscal_year": FISCAL_YEAR,
        "agency_id": AGENCY_ID,
        "capture_complete": True,
        "source_status": "available",
        "source_sha256": receipt["sha256"],
        "counts": {
            "raw_rows": result["input_rows"],
            "distinct_program_sites": result["distinct_records"],
            "mapped_queens": result["mapped_records"],
            "excluded_queens": len(result["excluded"]),
            "duplicate_observations": result["duplicate_observations"],
        },
        "exclusions": result["excluded"],
        "shards": shards,
    }
    manifest_bytes = _json_bytes(manifest)
    if len(manifest_bytes) > MANIFEST_MAX_BYTES:
        raise SystemExit(f"manifest exceeds {MANIFEST_MAX_BYTES} bytes")

    proof = {
        "source_url": receipt["url"],
        "fiscal_year": FISCAL_YEAR,
        "publisher_updated_at": publisher_updated_at,
        "checked_at": receipt["captured_at"],
        "source_sha256": receipt["sha256"],
        "counts": manifest["counts"],
        "shard_count": len(shards),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
    }
    return {
        "manifest": manifest_bytes,
        "shards": shard_bodies,
        "proof": _json_bytes(proof),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-dir", type=Path, default=ROOT / "warehouse/fixtures/dycd-program-sites")
    parser.add_argument("--out-manifest", type=Path, default=ROOT / "site/data/agency_program_sites.json")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "site/data/agency_program_sites")
    parser.add_argument("--receipt", type=Path, default=ROOT / "warehouse/receipts/proof/dycd-program-sites/fy2026-queens.json")
    parser.add_argument("--check", action="store_true", help="rebuild and compare without writing")
    args = parser.parse_args(argv)

    built = build(args.fixture_dir)

    if args.check:
        drift = []
        if not args.out_manifest.is_file() or args.out_manifest.read_bytes() != built["manifest"]:
            drift.append(str(args.out_manifest))
        existing = {p.name: p.read_bytes() for p in args.out_dir.glob("*.json")} if args.out_dir.is_dir() else {}
        if existing != built["shards"]:
            drift.append(str(args.out_dir))
        if not args.receipt.is_file() or args.receipt.read_bytes() != built["proof"]:
            drift.append(str(args.receipt))
        if drift:
            print(json.dumps({"status": "drift", "paths": drift}))
            return 1
        print(json.dumps({"status": "ok", "shards": len(built["shards"])}))
        return 0

    args.out_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for stale in args.out_dir.glob("*.json"):
        if stale.name not in built["shards"]:
            stale.unlink()
    args.out_manifest.write_bytes(built["manifest"])
    for name, payload in built["shards"].items():
        (args.out_dir / name).write_bytes(payload)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_bytes(built["proof"])
    print(json.dumps({"status": "written", "shards": len(built["shards"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
