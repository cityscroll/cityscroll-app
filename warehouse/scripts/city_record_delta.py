#!/usr/bin/env python3
"""Build one dated, resumable City Record delta export.

This is intentionally source-specific. City Record declares a stable composite
cursor (start_date, request_id); no other warehouse source inherits that contract.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path


DATASET_ID = "dg92-zbpx"
DOMAIN = "https://data.cityofnewyork.us"
CURSOR_FIELDS = ("start_date", "request_id")
USER_AGENT = "CityScrollWarehouse/0.3 (+https://cityscroll.org; City Record delta proof)"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        fields = list(reader.fieldnames or [])
        rows = [{key: value or "" for key, value in row.items()} for row in reader]
    missing = [field for field in CURSOR_FIELDS if field not in fields]
    if missing:
        raise ValueError(f"{path} lacks cursor fields: {', '.join(missing)}")
    return fields, rows


def cursor(row: dict[str, str]) -> tuple[str, str]:
    return (
        str(row.get("start_date") or ""),
        str(row.get("request_id") or ""),
    )


def cursor_payload(value: tuple[str, str]) -> dict[str, str]:
    return dict(zip(CURSOR_FIELDS, value, strict=True))


def canonical_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(rows, key=lambda row: (cursor(row), json.dumps(row, sort_keys=True)))


def csv_bytes(fields: list[str], rows: list[dict[str, str]]) -> bytes:
    from io import StringIO

    output = StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(canonical_rows(rows))
    return output.getvalue().encode("utf-8")


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sq(value: str) -> str:
    return value.replace("'", "''")


def city_record_page_url(after: tuple[str, str], limit: int) -> str:
    date, request_id = after
    where = (
        f"start_date > '{sq(date)}' OR "
        f"(start_date = '{sq(date)}' AND request_id > '{sq(request_id)}')"
    )
    query = urllib.parse.urlencode(
        {
            "$where": where,
            "$order": "start_date ASC, request_id ASC",
            "$limit": str(limit),
        }
    )
    return f"{DOMAIN}/resource/{DATASET_ID}.csv?{query}"


def fetch_live_page(after: tuple[str, str], limit: int) -> tuple[list[str], list[dict[str, str]]]:
    request = urllib.request.Request(
        city_record_page_url(after, limit),
        headers={"User-Agent": USER_AGENT, "Accept": "text/csv"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = response.read()
    from io import StringIO

    reader = csv.DictReader(StringIO(payload.decode("utf-8")))
    return list(reader.fieldnames or []), [dict(row) for row in reader]


def fixture_page(
    rows: list[dict[str, str]], after: tuple[str, str], limit: int
) -> list[dict[str, str]]:
    return [row for row in canonical_rows(rows) if cursor(row) > after][:limit]


def dedupe_delta(
    snapshot: list[dict[str, str]], candidates: list[dict[str, str]]
) -> tuple[list[dict[str, str]], int]:
    snapshot_ids = {row["request_id"] for row in snapshot}
    accepted: dict[str, dict[str, str]] = {}
    duplicate_count = 0
    for row in canonical_rows(candidates):
        request_id = row["request_id"]
        if request_id in snapshot_ids or request_id in accepted:
            duplicate_count += 1
            continue
        accepted[request_id] = row
    return canonical_rows(list(accepted.values())), duplicate_count


def normalized_fields(snapshot_fields: list[str], page_fields: list[str]) -> list[str]:
    return snapshot_fields + sorted(set(page_fields) - set(snapshot_fields))


def portable(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return path.name


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dated City Record warehouse delta export")
    parser.add_argument("--snapshot", type=Path, required=True, help="Immutable baseline CSV")
    parser.add_argument("--export-date", required=True, help="UTC date, YYYY-MM-DD")
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--source-fixture", type=Path, help="Offline source rows for proof/tests")
    parser.add_argument("--expected-final", type=Path, help="Independent full snapshot equivalence fixture")
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--max-rows", type=int, default=5000)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--stop-after-pages", type=int, default=0, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    try:
        args.export_date = date.fromisoformat(args.export_date).isoformat()
    except ValueError as error:
        raise SystemExit("--export-date must be YYYY-MM-DD") from error
    if args.page_size < 1 or args.max_rows < 1:
        raise SystemExit("--page-size and --max-rows must be positive")

    export_dir = args.output_root / "city-record" / f"delta_date={args.export_date}"
    pages_dir = export_dir / "pages"
    checkpoint_path = export_dir / "checkpoint.json"
    rows_path = export_dir / "rows.csv"
    receipt_path = export_dir / "receipt.json"
    snapshot_fields, snapshot_rows = read_rows(args.snapshot)
    if not snapshot_rows:
        raise SystemExit("baseline snapshot must contain at least one row")
    start_cursor = max(cursor(row) for row in snapshot_rows)
    source_fields: list[str] = []
    fixture_rows: list[dict[str, str]] = []
    if args.source_fixture:
        source_fields, fixture_rows = read_rows(args.source_fixture)
    source_identity = sha256_file(args.source_fixture) if args.source_fixture else "live-socrata"
    identity = {
        "dataset_id": DATASET_ID,
        "export_date": args.export_date,
        "snapshot_sha256": sha256_file(args.snapshot),
        "source_identity": source_identity,
        "start_cursor": cursor_payload(start_cursor),
        "page_size": args.page_size,
        "max_rows": args.max_rows,
    }

    if checkpoint_path.exists():
        if not args.resume:
            raise SystemExit(f"delta progress exists at {checkpoint_path}; re-run with --resume")
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("identity") != identity:
            raise SystemExit("delta checkpoint does not match snapshot, cursor, source, or bounds")
        if checkpoint.get("complete") and rows_path.exists() and receipt_path.exists():
            print(receipt_path)
            return 0
        checkpoint["resume_count"] = int(checkpoint.get("resume_count") or 0) + 1
        write_json(checkpoint_path, checkpoint)
    else:
        if args.resume:
            raise SystemExit(f"no delta checkpoint to resume at {checkpoint_path}")
        export_dir.mkdir(parents=True, exist_ok=True)
        pages_dir.mkdir(parents=True, exist_ok=True)
        checkpoint = {
            "schema_version": 1,
            "identity": identity,
            "complete": False,
            "resume_count": 0,
            "pages": [],
        }
        write_json(checkpoint_path, checkpoint)

    while not checkpoint["complete"]:
        fetched_count = sum(page["row_count"] for page in checkpoint["pages"])
        remaining = args.max_rows - fetched_count
        if remaining <= 0:
            checkpoint["complete"] = True
            checkpoint["completion_reason"] = "max_rows"
            break
        after = start_cursor
        if checkpoint["pages"]:
            last = checkpoint["pages"][-1]["cursor_after"]
            after = (last["start_date"], last["request_id"])
        limit = min(args.page_size, remaining)
        if args.source_fixture:
            page_rows = fixture_page(fixture_rows, after, limit)
            page_fields = source_fields
        else:
            page_fields, page_rows = fetch_live_page(after, limit)
        if not page_rows:
            checkpoint["complete"] = True
            checkpoint["completion_reason"] = "source_exhausted"
            break
        page_after = max(cursor(row) for row in page_rows)
        page_path = pages_dir / f"page-{len(checkpoint['pages']):04d}.csv"
        fields = normalized_fields(snapshot_fields, page_fields)
        page_payload = csv_bytes(fields, page_rows)
        page_path.write_bytes(page_payload)
        checkpoint["pages"].append(
            {
                "path": portable(page_path, args.output_root),
                "row_count": len(page_rows),
                "sha256": sha256_bytes(page_payload),
                "cursor_after": cursor_payload(page_after),
            }
        )
        if len(page_rows) < limit:
            checkpoint["complete"] = True
            checkpoint["completion_reason"] = "source_exhausted"
        write_json(checkpoint_path, checkpoint)
        if args.stop_after_pages and len(checkpoint["pages"]) >= args.stop_after_pages:
            print(f"interrupted after {len(checkpoint['pages'])} page(s)")
            return 75

    write_json(checkpoint_path, checkpoint)
    candidates: list[dict[str, str]] = []
    all_fields = list(snapshot_fields)
    for page in checkpoint["pages"]:
        path = args.output_root / page["path"]
        fields, page_rows = read_rows(path)
        all_fields = normalized_fields(all_fields, fields)
        candidates.extend(page_rows)
    delta_rows, duplicate_count = dedupe_delta(snapshot_rows, candidates)
    delta_payload = csv_bytes(all_fields, delta_rows)
    rows_path.write_bytes(delta_payload)
    final_rows = canonical_rows(snapshot_rows + delta_rows)
    final_payload = csv_bytes(all_fields, final_rows)

    equivalence = {"checked": False, "equivalent": None, "expected_sha256": None}
    if args.expected_final:
        expected_fields, expected_rows = read_rows(args.expected_final)
        expected_payload = csv_bytes(normalized_fields(all_fields, expected_fields), expected_rows)
        equivalence = {
            "checked": True,
            "equivalent": expected_payload == final_payload,
            "expected_sha256": sha256_bytes(expected_payload),
        }
        if not equivalence["equivalent"]:
            raise SystemExit("delta-applied snapshot does not equal expected final snapshot")

    receipt = {
        "schema": "cityscroll.warehouse_delta_export_receipt.v1",
        "source": {"contract_id": "city-record", "dataset_id": DATASET_ID},
        "export": {
            "date_utc": args.export_date,
            "partition": f"delta_date={args.export_date}",
            "format": "csv-rfc4180-utf8-lf",
            "path": portable(rows_path, args.output_root),
            "sha256": sha256_bytes(delta_payload),
        },
        "cursor": {
            "order": ["start_date ASC", "request_id ASC"],
            "exclusive_after": cursor_payload(start_cursor),
            "final": cursor_payload(max((cursor(row) for row in delta_rows), default=start_cursor)),
        },
        "counts": {
            "snapshot_rows": len(snapshot_rows),
            "source_rows": len(candidates),
            "deduplicated_rows": duplicate_count,
            "delta_rows": len(delta_rows),
            "final_snapshot_rows": len(final_rows),
        },
        "resume": {
            "checkpoint": portable(checkpoint_path, args.output_root),
            "page_size": args.page_size,
            "page_count": len(checkpoint["pages"]),
            "completion_reason": checkpoint["completion_reason"],
            "resumed_from_checkpoint": checkpoint["resume_count"] > 0,
            "resume_count": checkpoint["resume_count"],
        },
        "final_snapshot": {
            "sha256": sha256_bytes(final_payload),
            "equivalence": equivalence,
        },
        "scope": "one-source-proof; no cursor semantics are implied for other sources",
    }
    write_json(receipt_path, receipt)
    print(receipt_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
