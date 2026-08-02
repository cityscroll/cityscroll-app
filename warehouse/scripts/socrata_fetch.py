"""Capped Socrata fetch — SODA $limit path (tiny), not full bulk rows.csv.

Full bulk export (rows.csv?accessType=DOWNLOAD) is WH-02 and must stay behind
the same CPU caps + explicit ack. WH-01 only exercises the small proof path.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = "CityScrollWarehouse/0.1 (+https://cityscroll.org; WH-01 scaffold)"


def soda_csv_url(domain: str, dataset_id: str, *, limit: int, order: str | None = None) -> str:
    base = domain.rstrip("/")
    params = {"$limit": str(limit)}  # SODA query args (not a data table)
    if order:
        params["$order"] = order
    q = urllib.parse.urlencode(params)
    return f"{base}/resource/{dataset_id}.csv?{q}"


def bulk_csv_url(domain: str, dataset_id: str) -> str:
    """Full export URL — do not call from WH-01 default paths."""
    base = domain.rstrip("/")
    return f"{base}/api/views/{dataset_id}/rows.csv?accessType=DOWNLOAD"


def fetch_to_file(url: str, dest: Path, *, timeout: int = 60) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".partial")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/csv,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            # HTTP response headers map (not a sourced data table)
            headers = {k.lower(): v for k, v in resp.headers.items()}  # source: HTTP response
            with partial.open("wb") as out:
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            status = getattr(resp, "status", 200)
    except urllib.error.HTTPError as e:
        if partial.exists():
            partial.unlink(missing_ok=True)
        raise SystemExit(f"Socrata fetch HTTP {e.code} for {url}: {e.reason}") from e
    except urllib.error.URLError as e:
        if partial.exists():
            partial.unlink(missing_ok=True)
        raise SystemExit(f"Socrata fetch failed for {url}: {e.reason}") from e

    partial.replace(dest)
    size = dest.stat().st_size
    # Count data rows (exclude header) without loading whole file into memory.
    rows = 0
    with dest.open("rb") as f:
        # skip header
        f.readline()
        for _ in f:
            rows += 1
    return {
        "url": url,
        "path": str(dest),
        "bytes": size,
        "http_status": status,
        "row_count": rows,
        "content_type": headers.get("content-type"),
        "last_modified": headers.get("last-modified"),
    }


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
