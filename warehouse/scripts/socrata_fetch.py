"""Capped Socrata fetch — SODA $limit path (tiny) and full bulk rows.csv (WH-02).

Full bulk export (rows.csv?accessType=DOWNLOAD) stays behind the same ingest lock,
headroom gate, and --ack-large confirmation as the rest of the warehouse runner.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = "CityScrollWarehouse/0.2 (+https://cityscroll.org; WH-02 bulk pack)"


def soda_csv_url(domain: str, dataset_id: str, *, limit: int, order: str | None = None) -> str:
    base = domain.rstrip("/")
    params = {"$limit": str(limit)}  # SODA query args (not a data table)
    if order:
        params["$order"] = order
    q = urllib.parse.urlencode(params)
    return f"{base}/resource/{dataset_id}.csv?{q}"


def bulk_csv_url(domain: str, dataset_id: str) -> str:
    """Full export URL — WH-02 only, behind lock + headroom + --ack-large."""
    base = domain.rstrip("/")
    return f"{base}/api/views/{dataset_id}/rows.csv?accessType=DOWNLOAD"


def view_meta_url(domain: str, dataset_id: str) -> str:
    base = domain.rstrip("/")
    return f"{base}/api/views/{dataset_id}.json"


def fetch_column_map(domain: str, dataset_id: str, *, timeout: int = 60) -> dict[str, str]:
    """Map bulk-export display headers (column name) → SODA fieldName (snake_case).

    Socrata rows.csv uses the view's column `name`; SODA resource API uses `fieldName`.
    Warehouse tables should match the product (fieldName).
    """
    url = view_meta_url(domain, dataset_id)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            meta = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Socrata view meta HTTP {e.code} for {url}: {e.reason}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"Socrata view meta failed for {url}: {e.reason}") from e

    mapping: dict[str, str] = {}  # code structure (not a sourced data table)
    for col in meta.get("columns") or []:
        field = col.get("fieldName") or ""
        name = col.get("name") or ""
        if not field or field.startswith(":"):
            continue
        if name and name != field:
            mapping[name] = field
        # Also accept already-snake headers idempotently
        mapping.setdefault(field, field)
    return mapping


def _count_csv_rows(path: Path) -> int:
    """Count data rows (exclude header) without loading whole file into memory."""
    rows = 0
    with path.open("rb") as f:
        f.readline()  # header
        for _ in f:
            rows += 1
    return rows


def fetch_to_file(
    url: str,
    dest: Path,
    *,
    timeout: int = 60,
    heartbeat_every_s: int = 0,
    label: str = "fetch",
) -> dict:
    """Stream URL to dest. Optional heartbeat lines on stderr for long bulk pulls."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".partial")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/csv,*/*"})
    started = time.time()
    last_hb = started
    written = 0
    h = hashlib.sha256()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            # HTTP response headers map (not a sourced data table)
            headers = {k.lower(): v for k, v in resp.headers.items()}  # source: HTTP response
            with partial.open("wb") as out:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    written += len(chunk)
                    now = time.time()
                    if heartbeat_every_s > 0 and (now - last_hb) >= heartbeat_every_s:
                        elapsed = int(now - started)
                        print(
                            f"  {label}: {written // (1024 * 1024)} MiB in {elapsed}s …",
                            file=sys.stderr,
                            flush=True,
                        )
                        last_hb = now
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
    rows = _count_csv_rows(dest)
    return {
        "url": url,
        "path": str(dest),
        "bytes": size,
        "http_status": status,
        "row_count": rows,
        "content_type": headers.get("content-type"),
        "last_modified": headers.get("last-modified"),
        "sha256": h.hexdigest(),
        "elapsed_s": round(time.time() - started, 2),
    }


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
