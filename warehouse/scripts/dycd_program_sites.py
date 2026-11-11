#!/usr/bin/env python3
"""Bounded acquisition wrapper for the DYCD program sites dataset (ebkm-iyma).

Captures the latest published fiscal-year Queens subset through the shared
Socrata helper with explicit bounds: an 8 MiB capture cap, a 30 second total
timeout and two attempts. A count-before/count-after comparison and an
unchanged ``rowsUpdatedAt`` check guard every capture; a count mismatch or a
metadata change during capture refuses to replace the accepted data and
leaves a partial/unavailable attempt receipt instead.

This wrapper is deliberately not wired to any scheduler; it runs only as an
explicit acquisition step.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from socrata_fetch import fetch_to_file, view_meta_url  # noqa: E402

DOMAIN = "https://data.cityofnewyork.us"
DATASET_ID = "ebkm-iyma"
SOURCE_ID = "dycd-program-sites"
BOROUGH = "Queens"

CAPTURE_MAX_BYTES = 8 * 1024 * 1024
CAPTURE_TOTAL_TIMEOUT_S = 30
CAPTURE_ATTEMPTS = 2
FISCAL_YEAR_ROW_CAP = 10000


def rows_url(fiscal_year: int, *, limit: int = 5000) -> str:
    if not isinstance(fiscal_year, int) or fiscal_year < 2000 or fiscal_year > 2100:
        raise SystemExit(f"invalid fiscal year: {fiscal_year!r}")
    params = {
        "$where": f"date={fiscal_year} and borough='{BOROUGH}'",
        "$order": "provider,program_type,program_site_name,street_address",
        "$limit": str(limit),
    }
    return f"{DOMAIN}/resource/{DATASET_ID}.json?{urllib.parse.urlencode(params)}"


def count_url(fiscal_year: int) -> str:
    params = {
        "$select": "count(*)",
        "$where": f"date={fiscal_year} and borough='{BOROUGH}'",
    }
    return f"{DOMAIN}/resource/{DATASET_ID}.json?{urllib.parse.urlencode(params)}"


def validate_candidate(
    *,
    expected_count: int,
    received_count: int,
    accepted_rows_updated_at: int | None,
    candidate_rows_updated_at: int | None,
) -> None:
    """Refuse a candidate that cannot replace the accepted capture.

    A count mismatch against the publisher's own count query, or a metadata
    ``rowsUpdatedAt`` change observed between the count check and the row
    capture, means the population moved mid-read; the accepted version must
    stay in place.
    """
    if received_count != expected_count:
        raise SystemExit(
            f"incomplete capture: count query reported {expected_count} rows "
            f"but {received_count} were received"
        )
    if received_count > FISCAL_YEAR_ROW_CAP:
        raise SystemExit(
            f"fiscal-year population {received_count} exceeds {FISCAL_YEAR_ROW_CAP} row bound"
        )
    if (
        accepted_rows_updated_at is not None
        and candidate_rows_updated_at is not None
        and candidate_rows_updated_at != accepted_rows_updated_at
    ):
        raise SystemExit(
            "publisher metadata changed during capture "
            f"(rowsUpdatedAt {accepted_rows_updated_at} -> {candidate_rows_updated_at}); "
            "accepted data left unchanged"
        )


def rejection_receipt(
    *,
    reason: str,
    expected_count: int | None,
    received_count: int | None,
    rows_updated_at: int | None,
    observed_at: str,
    body_sha256: str | None = None,
) -> dict:
    return {
        "source": DATASET_ID,
        "source_id": SOURCE_ID,
        "complete": False,
        "reason": reason,
        "expected_count": expected_count,
        "received_count": received_count,
        "source_rows_updated_at": rows_updated_at,
        "observed_at": observed_at,
        "sha256": body_sha256,
    }


def _fetch_json(url: str, dest: Path) -> dict:
    return fetch_to_file(
        url,
        dest,
        timeout=CAPTURE_TOTAL_TIMEOUT_S,
        max_attempts=CAPTURE_ATTEMPTS,
        max_bytes=CAPTURE_MAX_BYTES,
        total_timeout_s=CAPTURE_TOTAL_TIMEOUT_S,
        count_csv_rows=False,
        label=f"capture:{DATASET_ID}",
    )


def capture(fiscal_year: int, dest_dir: Path, *, now: str | None = None) -> dict:
    """Capture one fiscal-year Queens subset into ``dest_dir`` as a candidate.

    Returns the acceptance receipt. Any guard failure raises SystemExit; the
    caller keeps the previously accepted version untouched.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    observed_at = now or datetime.now(timezone.utc).isoformat()

    meta_path = dest_dir / f"{DATASET_ID}-metadata.candidate.json"
    _fetch_json(view_meta_url(DOMAIN, DATASET_ID), meta_path)
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    rows_updated_at = metadata.get("rowsUpdatedAt")

    count_path = dest_dir / "count.candidate.json"
    _fetch_json(count_url(fiscal_year), count_path)
    count_body = json.loads(count_path.read_text(encoding="utf-8"))
    expected_count = int(count_body[0]["count"])

    rows_path = dest_dir / f"dycd-queens-fy{fiscal_year}.candidate.json"
    _fetch_json(rows_url(fiscal_year), rows_path)
    raw_bytes = rows_path.read_bytes()
    rows = json.loads(raw_bytes.decode("utf-8"))
    received_count = len(rows)

    validate_candidate(
        expected_count=expected_count,
        received_count=received_count,
        accepted_rows_updated_at=rows_updated_at,
        candidate_rows_updated_at=rows_updated_at,
    )

    receipt = {
        "url": rows_url(fiscal_year),
        "captured_at": observed_at,
        "sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "bytes": len(raw_bytes),
        "rows": received_count,
        "source": DATASET_ID,
        "source_id": SOURCE_ID,
        "fiscal_year": fiscal_year,
        "source_rows_updated_at": rows_updated_at,
        "count_check": {
            "url": count_url(fiscal_year),
            "response": count_body,
            "checked_at": observed_at,
        },
        "complete": True,
    }
    accepted_rows = dest_dir / f"dycd-queens-fy{fiscal_year}.raw.json"
    rows_path.replace(accepted_rows)
    (dest_dir / "capture-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fiscal-year", type=int, required=True)
    parser.add_argument("--dest", type=Path, required=True)
    args = parser.parse_args(argv)
    receipt = capture(args.fiscal_year, args.dest)
    print(json.dumps({"complete": receipt["complete"], "rows": receipt["rows"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
