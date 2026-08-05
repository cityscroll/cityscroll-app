#!/usr/bin/env python3
"""Prove and export a bounded Recent Contract Awards delta.

The cursor contract is source-specific and is enabled only after an observed
OCP ordering sample has unique, non-null, strictly monotonic composite keys.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import date
from io import StringIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cpu_guard import IngestLock, check_headroom


DATASET_ID = "qyyg-4tf5"
CONTRACT_ID = "ocp-recent-contract-awards"
DOMAIN = "https://data.cityofnewyork.us"
CURSOR_FIELDS = ("start_date", "request_id")
USER_AGENT = "CityScrollWarehouse/0.4 (+https://cityscroll.org; OCP delta semantics proof)"
REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "warehouse" / "fixtures" / "ocp-awards-delta"
PROOF_RECEIPT = REPO_ROOT / "warehouse" / "receipts" / "proof" / "ocp_awards_delta_fixture.json"


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
    return tuple(str(row.get(field) or "") for field in CURSOR_FIELDS)  # type: ignore[return-value]


def cursor_payload(value: tuple[str, str]) -> dict[str, str]:
    return dict(zip(CURSOR_FIELDS, value, strict=True))


def canonical_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(rows, key=lambda row: (cursor(row), json.dumps(row, sort_keys=True)))


def csv_bytes(fields: list[str], rows: list[dict[str, str]]) -> bytes:
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


def ocp_awards_page_url(
    after: tuple[str, str], limit: int, through: tuple[str, str] | None = None
) -> str:
    start_date, request_id = after
    exclusive = (
        f"start_date > '{sq(start_date)}' OR "
        f"(start_date = '{sq(start_date)}' AND request_id > '{sq(request_id)}')"
    )
    where = exclusive
    if through:
        through_date, through_id = through
        inclusive = (
            f"start_date < '{sq(through_date)}' OR "
            f"(start_date = '{sq(through_date)}' AND request_id <= '{sq(through_id)}')"
        )
        where = f"({exclusive}) AND ({inclusive})"
    query = urllib.parse.urlencode(
        {
            "$where": where,
            "$order": "start_date ASC, request_id ASC",
            "$limit": str(limit),
        }
    )
    return f"{DOMAIN}/resource/{DATASET_ID}.csv?{query}"


def _fetch_csv(url: str) -> tuple[list[str], list[dict[str, str]]]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/csv"})
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = response.read()
    reader = csv.DictReader(StringIO(payload.decode("utf-8")))
    return list(reader.fieldnames or []), [dict(row) for row in reader]


def fetch_live_page(
    after: tuple[str, str], limit: int, through: tuple[str, str] | None = None
) -> tuple[list[str], list[dict[str, str]]]:
    return _fetch_csv(ocp_awards_page_url(after, limit, through))


def fetch_live_probe(limit: int) -> list[dict[str, str]]:
    query = urllib.parse.urlencode(
        {
            "$select": "start_date,request_id",
            "$where": "start_date is not null AND request_id is not null",
            "$order": "start_date DESC, request_id DESC",
            "$limit": str(limit),
        }
    )
    _, rows = _fetch_csv(f"{DOMAIN}/resource/{DATASET_ID}.csv?{query}")
    return rows


def fetch_live_window(limit: int) -> tuple[list[str], list[dict[str, str]]]:
    query = urllib.parse.urlencode(
        {
            "$where": "start_date is not null AND request_id is not null",
            "$order": "start_date DESC, request_id DESC",
            "$limit": str(limit),
        }
    )
    return _fetch_csv(f"{DOMAIN}/resource/{DATASET_ID}.csv?{query}")


def fixture_page(
    rows: list[dict[str, str]], after: tuple[str, str], limit: int
) -> list[dict[str, str]]:
    return [row for row in canonical_rows(rows) if cursor(row) > after][:limit]


def ordering_evidence(rows: list[dict[str, str]], *, descending: bool = False) -> dict:
    pairs = [cursor(row) for row in rows]
    missing = sum(1 for pair in pairs if not all(pair))
    duplicates = len(pairs) - len(set(pairs))
    if descending:
        non_monotonic = sum(1 for left, right in zip(pairs, pairs[1:]) if left <= right)
    else:
        non_monotonic = sum(1 for left, right in zip(pairs, pairs[1:]) if left >= right)
    return {
        "verified": bool(pairs) and missing == 0 and duplicates == 0 and non_monotonic == 0,
        "sample_rows": len(pairs),
        "missing_cursor_rows": missing,
        "duplicate_cursor_pairs": duplicates,
        "non_monotonic_pairs": non_monotonic,
        "observed_order": "descending" if descending else "ascending",
    }


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


def fixture_defaults(args: argparse.Namespace) -> None:
    if not args.from_fixture:
        return
    args.snapshot = args.snapshot or FIXTURE_DIR / "baseline.csv"
    args.source_fixture = args.source_fixture or FIXTURE_DIR / "source_rows.csv"
    args.expected_final = args.expected_final or FIXTURE_DIR / "expected_final.csv"
    args.export_date = args.export_date or "2026-08-05"
    args.force_headroom = True


def prepare_live_proof(args: argparse.Namespace, root: Path) -> None:
    if args.max_rows < 1:
        raise SystemExit("--max-rows must be positive")
    fields, descending_rows = fetch_live_window(args.max_rows + 1)
    if len(descending_rows) < 2:
        raise SystemExit("bounded live proof needs at least two OCP rows")
    rows = canonical_rows(descending_rows)
    baseline = rows[:1]
    args.snapshot = root / "baseline.csv"
    args.expected_final = root / "expected_final.csv"
    args.snapshot.write_bytes(csv_bytes(fields, baseline))
    args.expected_final.write_bytes(csv_bytes(fields, rows))
    args.through_cursor = cursor(rows[-1])
    args.max_rows = len(rows) - 1


def run(args: argparse.Namespace) -> Path:
    if not args.snapshot or not args.output_root or not args.export_date:
        raise SystemExit("--snapshot, --output-root, and --export-date are required")
    try:
        args.export_date = date.fromisoformat(args.export_date).isoformat()
    except ValueError as error:
        raise SystemExit("--export-date must be YYYY-MM-DD") from error
    if args.page_size < 1 or args.max_rows < 1 or args.probe_rows < 1:
        raise SystemExit("--page-size, --max-rows, and --probe-rows must be positive")

    export_dir = args.output_root / CONTRACT_ID / f"delta_date={args.export_date}"
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
        probe = fixture_page(fixture_rows, ("", ""), args.probe_rows)
        ordering = ordering_evidence(probe)
        source_identity = sha256_file(args.source_fixture)
        evidence_basis = "synthetic-fixture"
    else:
        probe = fetch_live_probe(args.probe_rows)
        ordering = ordering_evidence(probe, descending=True)
        source_identity = "live-socrata"
        evidence_basis = "bounded-live-measurement"

    if not ordering["verified"]:
        stop = {
            "schema": "cityscroll.ocp_awards_delta_stop_receipt.v1",
            "source": {"contract_id": CONTRACT_ID, "dataset_id": DATASET_ID},
            "status": "stopped",
            "reason": "composite ordering did not pass the bounded source-specific probe",
            "ordering": ordering,
            "evidence": {"basis": evidence_basis},
        }
        write_json(receipt_path, stop)
        raise SystemExit("OCP composite ordering was not stable enough; wrote stop receipt")

    identity = {
        "dataset_id": DATASET_ID,
        "export_date": args.export_date,
        "snapshot_sha256": sha256_file(args.snapshot),
        "source_identity": source_identity,
        "start_cursor": cursor_payload(start_cursor),
        "page_size": args.page_size,
        "max_rows": args.max_rows,
        "probe_rows": args.probe_rows,
        "through_cursor": cursor_payload(args.through_cursor) if args.through_cursor else None,
    }
    if checkpoint_path.exists():
        if not args.resume:
            raise SystemExit(f"delta progress exists at {checkpoint_path}; re-run with --resume")
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("identity") != identity:
            raise SystemExit("delta checkpoint does not match snapshot, cursor, source, or bounds")
        if checkpoint.get("complete") and rows_path.exists() and receipt_path.exists():
            print(receipt_path)
            return receipt_path
        checkpoint["resume_count"] = int(checkpoint.get("resume_count") or 0) + 1
        write_json(checkpoint_path, checkpoint)
    else:
        if args.resume:
            raise SystemExit(f"no delta checkpoint to resume at {checkpoint_path}")
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
            page_fields, page_rows = fetch_live_page(after, limit, args.through_cursor)
        if not page_rows:
            checkpoint["complete"] = True
            checkpoint["completion_reason"] = "source_exhausted"
            break
        page_ordering = ordering_evidence(page_rows)
        if not page_ordering["verified"] or cursor(page_rows[0]) <= after:
            raise SystemExit("OCP page violated the verified exclusive cursor ordering")
        page_after = cursor(page_rows[-1])
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
            raise SystemExit(75)

    write_json(checkpoint_path, checkpoint)
    candidates: list[dict[str, str]] = []
    all_fields = list(snapshot_fields)
    for page in checkpoint["pages"]:
        fields, page_rows = read_rows(args.output_root / page["path"])
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
            raise SystemExit("delta-applied snapshot does not equal independent final snapshot")

    receipt = {
        "schema": "cityscroll.ocp_awards_delta_export_receipt.v1",
        "source": {"contract_id": CONTRACT_ID, "dataset_id": DATASET_ID},
        "evidence": {"basis": evidence_basis},
        "ordering": ordering,
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
            "inclusive_through": cursor_payload(args.through_cursor) if args.through_cursor else None,
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
        "final_snapshot": {"sha256": sha256_bytes(final_payload), "equivalence": equivalence},
        "discipline": {"single_job_lock": True, "headroom_gated": True, "one_dataset": True},
        "scope": "OCP Recent Contract Awards only; no cursor semantics are inherited from another source",
    }
    write_json(receipt_path, receipt)
    print(receipt_path)
    return receipt_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bounded OCP Recent Contract Awards delta proof")
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--export-date")
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--source-fixture", type=Path)
    parser.add_argument("--expected-final", type=Path)
    parser.add_argument("--from-fixture", action="store_true")
    parser.add_argument("--live-proof", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--page-size", type=int, default=2)
    parser.add_argument("--max-rows", type=int, default=10)
    parser.add_argument("--probe-rows", type=int, default=5000)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--force-headroom", action="store_true")
    parser.add_argument("--stop-after-pages", type=int, default=0, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    args.through_cursor = None
    fixture_defaults(args)

    temporary = None
    live_temporary = None
    if args.from_fixture and args.live_proof:
        raise SystemExit("cannot combine --from-fixture and --live-proof")
    if args.live_proof:
        if not args.output_root or not args.export_date:
            raise SystemExit("--live-proof requires --output-root and --export-date")
        live_temporary = tempfile.TemporaryDirectory(prefix="ocp-awards-live-proof-")
        prepare_live_proof(args, Path(live_temporary.name))
    elif args.from_fixture and not args.output_root:
        temporary = tempfile.TemporaryDirectory(prefix="ocp-awards-delta-check-")
        args.output_root = Path(temporary.name)

    try:
        with IngestLock():
            check_headroom(force=args.force_headroom)
            receipt_path = run(args)
        if args.check:
            if not PROOF_RECEIPT.is_file():
                raise SystemExit(f"committed fixture proof is missing: {PROOF_RECEIPT}")
            actual = json.loads(receipt_path.read_text(encoding="utf-8"))
            expected = json.loads(PROOF_RECEIPT.read_text(encoding="utf-8"))
            if actual != expected:
                raise SystemExit("fixture proof differs from the committed receipt")
            print("OK: fixture proof matches committed receipt")
        return 0
    finally:
        if temporary:
            temporary.cleanup()
        if live_temporary:
            live_temporary.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
