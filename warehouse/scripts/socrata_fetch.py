"""Capped Socrata fetch — SODA $limit path (tiny) and full bulk rows.csv (WH-02).

Full bulk export (rows.csv?accessType=DOWNLOAD) stays behind the same ingest lock,
headroom gate, and --ack-large confirmation as the rest of the warehouse runner.
"""

from __future__ import annotations

import hashlib
import csv
import json
import shutil
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


def soda_csv_page_url(
    domain: str,
    dataset_id: str,
    *,
    limit: int,
    offset: int,
    order: str,
) -> str:
    """Stable SODA CSV page used by resumable large snapshots."""
    base = domain.rstrip("/")
    params = {
        "$limit": str(limit),
        "$offset": str(offset),
        "$order": order,
    }
    return f"{base}/resource/{dataset_id}.csv?{urllib.parse.urlencode(params)}"


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
    """Count logical CSV records, including records with embedded newlines."""
    with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)
        return sum(1 for _ in reader)


def _page_profile(path: Path) -> dict:
    """Collect the receipt fields needed for the City Record historical pack."""
    min_date = None
    max_date = None
    section_counts: dict[str, int] = {}  # source: City Record section_name values
    with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        for row in csv.DictReader(f):
            start_date = (row.get("start_date") or "").strip()
            if start_date:
                min_date = start_date if min_date is None or start_date < min_date else min_date
                max_date = start_date if max_date is None or start_date > max_date else max_date
            section = (row.get("section_name") or "").strip()
            if section:
                section_counts[section] = section_counts.get(section, 0) + 1
    return {
        "start_date_min": min_date,
        "start_date_max": max_date,
        "section_counts": section_counts,
    }


def _merge_profiles(profiles: list[dict]) -> dict:
    mins = [p.get("start_date_min") for p in profiles if p.get("start_date_min")]  # source: City Record pages
    maxes = [p.get("start_date_max") for p in profiles if p.get("start_date_max")]  # source: City Record pages
    sections: dict[str, int] = {}  # source: City Record page profiles
    for profile in profiles:
        for section, count in (profile.get("section_counts") or {}).items():
            sections[section] = sections.get(section, 0) + int(count)
    return {
        "start_date_min": min(mins) if mins else None,
        "start_date_max": max(maxes) if maxes else None,
        "section_counts": dict(sorted(sections.items())),
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_to_file(
    url: str,
    dest: Path,
    *,
    timeout: int = 60,
    heartbeat_every_s: int = 0,
    label: str = "fetch",
    max_attempts: int = 3,
    backoff_s: float = 2.0,
) -> dict:
    """Stream URL to dest. Optional heartbeat lines on stderr for long bulk pulls."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".partial")
    started = time.time()
    last_hb = started
    headers: dict[str, str] = {}  # source: HTTP response metadata
    status = 0
    written = 0
    h = hashlib.sha256()
    for attempt in range(1, max_attempts + 1):
        request_headers = {  # code structure (not a sourced data record)
            "User-Agent": USER_AGENT,
            "Accept": "text/csv,*/*",
        }
        req = urllib.request.Request(url, headers=request_headers)
        written = 0
        h = hashlib.sha256()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                headers = {  # source: HTTP response metadata
                    k.lower(): v for k, v in resp.headers.items()
                }
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
            break
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            partial.unlink(missing_ok=True)
            retryable = not isinstance(e, urllib.error.HTTPError) or e.code == 429 or e.code >= 500
            if not retryable or attempt >= max_attempts:
                if isinstance(e, urllib.error.HTTPError):
                    raise SystemExit(
                        f"Socrata fetch HTTP {e.code} for {url}: {e.reason}"
                    ) from e
                raise SystemExit(f"Socrata fetch failed for {url}: {e.reason}") from e
            delay = backoff_s * (2 ** (attempt - 1))
            print(
                f"  {label}: retry {attempt + 1}/{max_attempts} in {delay:g}s",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(delay)

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


def fetch_paged_csv_to_file(
    domain: str,
    dataset_id: str,
    dest: Path,
    *,
    page_size: int,
    order: str,
    timeout: int,
    heartbeat_every_s: int,
    polite_delay_s: float,
    resume: bool,
) -> dict:
    """Fetch checkpointed SODA pages and consolidate them into one raw CSV."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    pages_dir = dest.with_suffix(".pages")
    checkpoint_path = dest.with_suffix(".checkpoint.json")
    if checkpoint_path.exists():
        if not resume:
            raise SystemExit(
                f"Paged bulk progress exists at {checkpoint_path}; re-run with --resume"
            )
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("page_size") != page_size or checkpoint.get("order") != order:
            raise SystemExit("Paged bulk checkpoint does not match configured page size/order")
    else:
        checkpoint = {
            "schema_version": 1,
            "dataset_id": dataset_id,
            "page_size": page_size,
            "order": order,
            "complete": False,
            "pages": [],
        }
        write_json(checkpoint_path, checkpoint)

    pages_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()
    while not checkpoint.get("complete"):
        offset = sum(int(page["row_count"]) for page in checkpoint["pages"])
        page_path = pages_dir / f"offset-{offset:09d}.csv"
        url = soda_csv_page_url(
            domain,
            dataset_id,
            limit=page_size,
            offset=offset,
            order=order,
        )
        meta = fetch_to_file(
            url,
            page_path,
            timeout=timeout,
            heartbeat_every_s=heartbeat_every_s,
            label=f"bulk:{dataset_id}:offset={offset}",
        )
        profile = _page_profile(page_path)
        checkpoint["pages"].append(
            {
                "offset": offset,
                "path": str(page_path),
                "row_count": meta["row_count"],
                "bytes": meta["bytes"],
                "sha256": meta["sha256"],
                "profile": profile,
            }
        )
        checkpoint["complete"] = meta["row_count"] < page_size
        write_json(checkpoint_path, checkpoint)
        total_rows = sum(int(page["row_count"]) for page in checkpoint["pages"])
        print(
            f"  bulk:{dataset_id}: heartbeat rows={total_rows} pages={len(checkpoint['pages'])}",
            file=sys.stderr,
            flush=True,
        )
        if not checkpoint["complete"] and polite_delay_s > 0:
            time.sleep(polite_delay_s)

    partial = dest.with_suffix(dest.suffix + ".partial")
    with partial.open("wb") as out:
        for index, page in enumerate(checkpoint["pages"]):
            with Path(page["path"]).open("rb") as src:
                if index:
                    src.readline()
                shutil.copyfileobj(src, out, length=1024 * 1024)
    partial.replace(dest)
    profiles = [page.get("profile") or {} for page in checkpoint["pages"]]
    return {
        "url": f"{domain.rstrip('/')}/resource/{dataset_id}.csv",
        "path": str(dest),
        "bytes": dest.stat().st_size,
        "http_status": 200,
        "row_count": sum(int(page["row_count"]) for page in checkpoint["pages"]),
        "sha256": _sha256_file(dest),
        "elapsed_s": round(time.time() - started, 2),
        "paging": {
            "strategy": "soda_offset",
            "page_size": page_size,
            "page_count": len(checkpoint["pages"]),
            "order": order,
            "checkpoint_path": str(checkpoint_path),
            "resumable": True,
            "polite_delay_s": polite_delay_s,
        },
        "snapshot_profile": _merge_profiles(profiles),
    }


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
