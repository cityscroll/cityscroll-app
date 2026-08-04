#!/usr/bin/env python3
"""Host-side RC-1 collector for MOCS FY2027 plans and capital projects.

The script stops at infrastructure: publisher files, normalized DuckDB tables,
fixed-sample bridge measurements, receipts, and a versioned reader payload. It
does not render or deploy the dependent Money surface.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(REPO_ROOT / "warehouse" / "lib"))

from cpu_guard import IngestLock, check_headroom  # noqa: E402
from paths import duckdb_path  # noqa: E402
from procurement_plans import (  # noqa: E402
    build_bridge_measurement,
    clean_text,
    load_review_labels,
    normalize_capital_row,
    normalize_plan_rows,
    parse_plan_index,
)


LL63_INDEX = "https://www.nyc.gov/site/mocs/resources/standard-prof-services-ll63.page"
LL1_INDEX = "https://www.nyc.gov/site/mocs/resources/m-wbe-ll1.page"
CAPITAL_DATASET = "https://data.cityofnewyork.us/resource/fb86-vt7u.json"
CAPITAL_LANDING = "https://data.cityofnewyork.us/d/fb86-vt7u"
CITY_RECORD_DATASET = "https://data.cityofnewyork.us/resource/dg92-zbpx.json"
PASSPORT_CONTRACTS = "https://a0333-passportpublic.nyc.gov/dataJs/contractData.js"
PASSPORT_RFX = "https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js"

MINIMUM_DELAY_MS = 1_200
PUBLIC_SHARD_ROWS = 10_000
PUBLIC_SHARD_MAX_BYTES = 20 * 1024 * 1024
USER_AGENT = (
    "Mozilla/5.0 (compatible; CityScrollProcurementPlans/1.0; "
    "+https://cityscroll.org; official procurement-plan materialization)"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class CheckpointedCollector:
    """Conditional, resumable publisher fetches with a single polite cadence."""

    def __init__(self, output_dir: Path, *, delay_ms: int, refresh: bool) -> None:
        if delay_ms < MINIMUM_DELAY_MS:
            raise SystemExit(f"live collection minimum delay is {MINIMUM_DELAY_MS} ms")
        self.output_dir = output_dir
        self.files_dir = output_dir / "publisher-files"
        self.checkpoint_path = output_dir / "checkpoint.json"
        self.delay_ms = delay_ms
        self.refresh = refresh
        self.last_request_at = 0.0
        try:
            self.checkpoint = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            self.checkpoint = {"schema": "cityscroll.procurement_plans.checkpoint.v1", "completed": {}}

    def _wait(self) -> None:
        elapsed_ms = (time.monotonic() - self.last_request_at) * 1000
        if self.last_request_at and elapsed_ms < self.delay_ms:
            time.sleep((self.delay_ms - elapsed_ms) / 1000)

    def _save_checkpoint(self) -> None:
        write_json(self.checkpoint_path, self.checkpoint)

    def fetch(self, url: str, *, suffix: str) -> tuple[bytes, dict[str, Any]]:
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()
        cached = self.checkpoint["completed"].get(url) or {}
        filename = f"{key[:16]}{suffix}"
        path = self.files_dir / filename
        if cached and path.is_file() and not self.refresh:
            data = path.read_bytes()
            if sha256_bytes(data) == cached.get("sha256"):
                return data, {**cached, "url": url, "checkpoint_hit": True}

        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*;q=0.8",
        }
        if cached.get("etag"):
            headers["If-None-Match"] = cached["etag"]
        if cached.get("last_modified"):
            headers["If-Modified-Since"] = cached["last_modified"]
        self._wait()
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read()
                response_headers = response.headers
                status = int(response.status)
        except urllib.error.HTTPError as error:
            self.last_request_at = time.monotonic()
            if error.code == 304 and cached and path.is_file():
                data = path.read_bytes()
                return data, {**cached, "url": url, "checkpoint_hit": True, "http_status": 304}
            if error.code == 403:
                raise RuntimeError(
                    f"publisher refused one polite host-side request (HTTP 403); stopped without retry: {url}"
                ) from error
            raise
        self.last_request_at = time.monotonic()
        self.files_dir.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        meta = {
            "url": url,
            "http_status": status,
            "bytes": len(data),
            "sha256": sha256_bytes(data),
            "etag": response_headers.get("ETag"),
            "last_modified": response_headers.get("Last-Modified"),
            "observed_at": utc_now(),
            "file": filename,
            "checkpoint_hit": False,
        }
        self.checkpoint["completed"][url] = {key: value for key, value in meta.items() if key != "url"}
        self._save_checkpoint()
        return data, meta


def agency_hint(link: dict[str, str]) -> str | None:
    label = clean_text(link.get("label"))
    if link.get("source") == "mocs_ll1":
        return label
    if not label:
        return None
    for pattern in (r"^New\s+(.+?)\s+Procurement", r"^(.+?)\s+Renewal", r"^(.+?)\s+Amendment"):
        match = re.search(pattern, label, flags=re.IGNORECASE)
        if match:
            return clean_text(match.group(1))
    return label


def workbook_plan_rows(path: Path, link: dict[str, str], fiscal_year: int) -> list[dict[str, Any]]:
    try:
        import openpyxl
    except ImportError as error:
        raise SystemExit("openpyxl is required; install warehouse/requirements.txt") from error
    rows: list[dict[str, Any]] = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            for worksheet in workbook.worksheets:
                values = [list(row) for row in worksheet.iter_rows(values_only=True)]
                normalized = normalize_plan_rows(
                    values,
                    source=link["source"],
                    source_url=link["url"],
                    agency_hint=agency_hint(link),
                    fiscal_year=fiscal_year,
                )
                for item in normalized:
                    item["source_sheet"] = worksheet.title
                rows.extend(normalized)
        finally:
            workbook.close()
    return rows


def fetch_json(collector: CheckpointedCollector, url: str, *, suffix: str = ".json") -> tuple[Any, dict[str, Any]]:
    data, meta = collector.fetch(url, suffix=suffix)
    return json.loads(data.decode("utf-8-sig")), meta


def city_record_url() -> str:
    params = {
        "$select": (
            "request_id,start_date,agency_name,pin,short_title,"
            "type_of_notice_description,additional_description_1"
        ),
        "$where": "section_name='Procurement' and start_date >= '2025-01-01T00:00:00'",
        "$order": "start_date DESC, request_id DESC",
        "$limit": "50000",
    }
    return f"{CITY_RECORD_DATASET}?{urllib.parse.urlencode(params)}"


def capital_url() -> str:
    return f"{CAPITAL_DATASET}?{urllib.parse.urlencode({'$limit': '50000', '$order': 'reporting_period DESC,pid'})}"


def parse_js_dump(
    text: str,
    variable: str,
    stats: dict[str, int] | None = None,
) -> list[list[Any]]:
    match = re.search(rf"var\s+{re.escape(variable)}\s*=\s*(\[.*\])\s*;?\s*$", text, flags=re.DOTALL)
    if not match:
        raise ValueError(f"PASSPort dump is missing {variable}")
    body = match.group(1).replace("\ufeff", "")
    try:
        payload = json.loads(body)
        if stats is not None:
            stats["malformed_rows_skipped"] = 0
        return payload if isinstance(payload, list) else []
    except json.JSONDecodeError:
        # PASSPort occasionally publishes a bad backslash escape in one row.
        # Mirror the product parser: retain independently valid row arrays and
        # count, rather than repair or silently reinterpret, malformed rows.
        rows = []
        skipped = 0
        for line in body.splitlines():
            candidate = line.strip().rstrip(",")
            if not candidate or candidate in ("[", "]"):
                continue
            try:
                row = json.loads(candidate)
            except json.JSONDecodeError:
                skipped += 1
                continue
            if isinstance(row, list):
                rows.append(row)
        if stats is not None:
            stats["malformed_rows_skipped"] = skipped
        return rows


def passport_targets(kind: str, arrays: list[list[Any]]) -> list[dict[str, Any]]:
    targets = []
    if kind == "passport_contract":
        for cells in arrays:
            if not isinstance(cells, list) or len(cells) < 17:
                continue
            epin = clean_text(cells[1])
            contract_id = clean_text(cells[2])
            if not epin:
                continue
            targets.append({
                "source": kind,
                "target_id": clean_text(cells[0]) or epin,
                "source_url": "https://a0333-passportpublic.nyc.gov/contracts.html",
                "agency": clean_text(cells[4]),
                "title": clean_text(cells[3]),
                "date": clean_text(cells[16]) or clean_text(cells[14]),
                "identifiers": [value for value in (epin, contract_id) if value],
            })
    else:
        for cells in arrays:
            if not isinstance(cells, list) or len(cells) < 10:
                continue
            epin = clean_text(cells[4])
            if not epin:
                continue
            targets.append({
                "source": kind,
                "target_id": clean_text(cells[0]) or epin,
                "source_url": "https://a0333-passportpublic.nyc.gov/rfx.html",
                "agency": clean_text(cells[6]),
                "title": clean_text(cells[5]),
                "date": clean_text(cells[8]),
                "identifiers": [epin],
            })
    return targets


def live_inputs(args: argparse.Namespace, collector: CheckpointedCollector) -> dict[str, Any]:
    source_files = []
    plans = []
    links = []
    for source, index_url in (("mocs_ll63", LL63_INDEX), ("mocs_ll1", LL1_INDEX)):
        data, index_meta = collector.fetch(index_url, suffix=".html")
        found = parse_plan_index(data.decode("utf-8", errors="replace"), index_url, source, args.fiscal_year)
        links.extend(found)
        source_files.append({
            "source": f"{source}_index",
            "url": index_url,
            "sha256": index_meta["sha256"],
            "bytes": index_meta["bytes"],
            "file_count": len(found),
        })

    for number, link in enumerate(links, 1):
        data, meta = collector.fetch(link["url"], suffix=".xlsx")
        local_path = collector.files_dir / meta["file"]
        normalized_path = args.output_dir / "normalized-files" / f"{meta['sha256']}.json"
        if normalized_path.is_file():
            normalized = json.loads(normalized_path.read_text(encoding="utf-8"))
        else:
            normalized = workbook_plan_rows(local_path, link, args.fiscal_year)
            write_json(normalized_path, normalized)
        plans.extend(normalized)
        source_files.append({
            "source": link["source"],
            "url": link["url"],
            "label": link["label"],
            "sha256": meta["sha256"],
            "bytes": meta["bytes"],
            "plan_rows": len(normalized),
        })
        print(f"xlsx {number}/{len(links)} {link['source']} rows={len(normalized)}", flush=True)

    capital_raw, capital_meta = fetch_json(collector, capital_url())
    capital = [normalize_capital_row(row) for row in capital_raw]
    source_files.append({
        "source": "capital_projects_dashboard",
        "url": CAPITAL_LANDING,
        "sha256": capital_meta["sha256"],
        "bytes": capital_meta["bytes"],
        "plan_rows": len(capital),
    })

    city_rows, city_meta = fetch_json(collector, city_record_url())
    city_targets = [{
        "source": "city_record",
        "target_id": clean_text(row.get("request_id")),
        "source_url": f"https://a856-cityrecord.nyc.gov/RequestDetail/{row.get('request_id')}",
        "agency": clean_text(row.get("agency_name")),
        "title": clean_text(row.get("short_title") or row.get("additional_description_1")),
        "date": clean_text(row.get("start_date")),
        "identifiers": [value for value in (clean_text(row.get("pin")),) if value],
    } for row in city_rows if row.get("request_id")]

    contracts_data, contracts_meta = collector.fetch(PASSPORT_CONTRACTS, suffix=".js")
    contract_parse_stats: dict[str, int] = {}
    contracts = passport_targets(
        "passport_contract",
        parse_js_dump(
            contracts_data.decode("utf-8-sig", errors="replace"),
            "public_ctr_data",
            contract_parse_stats,
        ),
    )
    rfx_data, rfx_meta = collector.fetch(PASSPORT_RFX, suffix=".js")
    rfx_parse_stats: dict[str, int] = {}
    rfx = passport_targets(
        "passport_rfx",
        parse_js_dump(
            rfx_data.decode("utf-8-sig", errors="replace"),
            "public_rfx_data",
            rfx_parse_stats,
        ),
    )
    return {
        "source_files": source_files,
        "plans": plans,
        "capital": capital,
        "targets": city_targets + contracts + rfx,
        "target_receipts": {
            "city_record": {"rows": len(city_targets), "sha256": city_meta["sha256"]},
            "passport_contracts": {
                "rows": len(contracts), "sha256": contracts_meta["sha256"],
                **contract_parse_stats,
            },
            "passport_rfx": {
                "rows": len(rfx), "sha256": rfx_meta["sha256"],
                **rfx_parse_stats,
            },
        },
    }


def fixture_inputs(fiscal_year: int) -> dict[str, Any]:
    fixture_path = REPO_ROOT / "warehouse" / "fixtures" / "procurement-plans" / "collector.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    ll63 = normalize_plan_rows(
        fixture["ll63_rows"], source="mocs_ll63", source_url=fixture["source_files"][0]["url"],
        agency_hint="ACS", fiscal_year=fiscal_year,
    )
    ll1 = normalize_plan_rows(
        fixture["ll1_rows"], source="mocs_ll1", source_url=fixture["source_files"][1]["url"],
        agency_hint="Administration for Children's Services", fiscal_year=fiscal_year,
    )
    targets = fixture["bridge_targets"]
    return {
        "source_files": fixture["source_files"],
        "plans": ll63 + ll1,
        "capital": [normalize_capital_row(row) for row in fixture["capital_rows"]],
        "measurement_plans": fixture["bridge_plans"],
        "targets": targets,
        "review_labels": fixture["review_labels"],
        "target_receipts": {
            "city_record": {
                "rows": sum(1 for row in targets if row["source"] == "city_record"),
                "sha256": "fixture-city-record",
            },
            "passport_contracts": {
                "rows": sum(1 for row in targets if row["source"] == "passport_contract"),
                "sha256": "fixture-passport-contracts",
            },
            "passport_rfx": {
                "rows": sum(1 for row in targets if row["source"] == "passport_rfx"),
                "sha256": "fixture-passport-rfx",
            },
        },
    }


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")


def materialize_warehouse(
    output_dir: Path,
    source_files: list[dict[str, Any]],
    plans: list[dict[str, Any]],
    capital: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> list[str]:
    import duckdb

    tables = {
        "mocs_procurement_plan_files": source_files,
        "mocs_procurement_plans": plans,
        "capital_projects_dashboard": capital,
        "procurement_plan_bridge_edges": edges,
    }
    database = duckdb_path()
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(database))
    try:
        connection.execute("PRAGMA threads=1")
        for table, rows in tables.items():
            jsonl = output_dir / f"{table}.jsonl"
            write_jsonl(jsonl, rows)
            connection.execute(f"DROP TABLE IF EXISTS {table}")
            if rows:
                connection.execute(
                    f"CREATE TABLE {table} AS SELECT * FROM read_json_auto(?)",
                    [str(jsonl)],
                )
            elif table == "procurement_plan_bridge_edges":
                connection.execute(f"""CREATE TABLE {table} (
                    plan_source_record_id VARCHAR, plan_source VARCHAR,
                    target_source VARCHAR, target_id VARCHAR, method VARCHAR,
                    identifier VARCHAR, score DOUBLE, provenance JSON
                )""")
            else:
                connection.execute(f"CREATE TABLE {table} (source_record_id VARCHAR)")
    finally:
        connection.close()
    return list(tables)


def build_payload(
    args: argparse.Namespace,
    source_files: list[dict[str, Any]],
    plans: list[dict[str, Any]],
    capital: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    generated_at: str,
) -> dict[str, Any]:
    return {
        "schema": "cityscroll.procurement_planning.v1",
        "generated_at": generated_at,
        "fiscal_year": args.fiscal_year,
        "contract": {
            "unmatched_rows_remain_unmatched": True,
            "infer_budget_from_agency_total": False,
            "reader_surface_included": False,
            "budget_provenance_required": True,
        },
        "sources": [{
            key: item.get(key) for key in ("source", "url", "label", "sha256", "plan_rows")
            if item.get(key) is not None
        } for item in source_files],
        "plans": plans,
        "capital_projects": capital,
        "bridge_edges": edges,
    }


def build_public_payload_bundle(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[tuple[str, bytes]]]:
    """Split the public payload into deterministic, Pages-safe JSON shards."""
    collections: dict[str, Any] = {}  # source: collected payload arrays below
    files: list[tuple[str, bytes]] = []  # source: encoded payload shards below
    for collection, filename_stem in (
        ("plans", "plans"),
        ("capital_projects", "capital-projects"),
        ("bridge_edges", "bridge-edges"),
    ):
        rows = payload[collection]
        shards = []  # source: one descriptor per encoded payload slice
        for index, start in enumerate(range(0, len(rows), PUBLIC_SHARD_ROWS)):
            shard_payload = {
                "schema": "cityscroll.procurement_planning.shard.v1",
                "collection": collection,
                "index": index,
                "rows": rows[start:start + PUBLIC_SHARD_ROWS],
            }
            encoded = (json.dumps(shard_payload, indent=2, sort_keys=False) + "\n").encode("utf-8")
            if len(encoded) > PUBLIC_SHARD_MAX_BYTES:
                raise ValueError(
                    f"public shard {collection}[{index}] is {len(encoded)} bytes; "
                    f"limit is {PUBLIC_SHARD_MAX_BYTES}"
                )
            filename = f"{filename_stem}-{index:03d}.json"
            path = f"site/data/procurement_planning_payload/{filename}"
            shards.append({
                "path": path,
                "rows": len(shard_payload["rows"]),
                "bytes": len(encoded),
                "sha256": sha256_bytes(encoded),
            })
            files.append((filename, encoded))
        collections[collection] = {  # source: current collected payload row counts
            "rows": len(rows), "shards": shards,
        }

    manifest = {
        "schema": "cityscroll.procurement_planning.manifest.v1",
        "generated_at": payload["generated_at"],
        "fiscal_year": payload["fiscal_year"],
        "contract": payload["contract"],
        "sources": payload["sources"],
        "collections": collections,
        "shard_contract": {
            "schema": "cityscroll.procurement_planning.shard.v1",
            "max_rows": PUBLIC_SHARD_ROWS,
            "max_bytes": PUBLIC_SHARD_MAX_BYTES,
        },
    }
    return manifest, files


def build_thread_lookup(payload: dict[str, Any]) -> dict[str, Any]:
    """Compact receipt-passed rows used to gate the deferred reader surface."""
    plans = {  # source: normalized publisher plan rows in the receipt-backed payload
        row.get("source_record_id"): row for row in payload["plans"]
    }
    rows = []  # source: materialized bridge edges paired with their publisher plan row
    for edge in payload["bridge_edges"]:
        plan = plans.get(edge.get("plan_source_record_id"))
        if plan is not None:
            rows.append({"edge": edge, "plan": plan})
    return {
        "schema": "cityscroll.procurement_planning.thread-lookup.v1",
        "generated_at": payload["generated_at"],
        "fiscal_year": payload["fiscal_year"],
        "contract": payload["contract"],
        "rows": rows,
    }


def public_payload_contract(manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": manifest["schema"],
        "path": "site/data/procurement_planning_payload.json",
        "schema_path": "site/data/procurement_planning_manifest.schema.json",
        "shard_schema": manifest["shard_contract"]["schema"],
        "shard_directory": "site/data/procurement_planning_payload",
        "max_shard_bytes": manifest["shard_contract"]["max_bytes"],
        "collections": manifest["collections"],
        "thread_lookup_path": "site/data/procurement_planning_thread_lookup.json",
        "reader_surface_included": False,
        "unmatched_rows_remain_unmatched": True,
        "infer_budget_from_agency_total": False,
    }


def publish_public_payload(payload: dict[str, Any], site_data: Path) -> dict[str, Any]:
    manifest, files = build_public_payload_bundle(payload)
    shard_dir = site_data / "procurement_planning_payload"
    shard_dir.mkdir(parents=True, exist_ok=True)
    expected = {filename for filename, _ in files}  # source: current bundle output
    for stale in shard_dir.glob("*.json"):
        if stale.name not in expected:
            stale.unlink()
    for filename, encoded in files:
        (shard_dir / filename).write_bytes(encoded)
    write_json(site_data / "procurement_planning_payload.json", manifest)
    write_json(site_data / "procurement_planning_thread_lookup.json", build_thread_lookup(payload))
    return manifest


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect and measure FY2027 procurement plans")
    parser.add_argument("--from-fixture", action="store_true")
    parser.add_argument("--fiscal-year", type=int, default=2027)
    parser.add_argument("--sample-size", type=int, default=100)
    parser.add_argument("--polite-delay-ms", type=int, default=MINIMUM_DELAY_MS)
    parser.add_argument("--refresh", action="store_true", help="conditionally revalidate completed URLs")
    parser.add_argument("--force-headroom", action="store_true")
    parser.add_argument("--publish", action="store_true", help="write the committed site payload and source receipt")
    parser.add_argument("--review-file", type=Path)
    parser.add_argument("--receipt-date", default=datetime.now(timezone.utc).date().isoformat())
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args(argv)
    if not 1 <= args.sample_size <= 1000:
        raise SystemExit("--sample-size must be 1..1000")
    if not args.from_fixture and args.polite_delay_ms < MINIMUM_DELAY_MS:
        raise SystemExit(f"live collection minimum delay is {MINIMUM_DELAY_MS} ms")
    if args.output_dir is None:
        args.output_dir = REPO_ROOT / "warehouse" / "raw" / "procurement-plans" / args.receipt_date
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    generated_at = utc_now()
    with IngestLock():
        headroom = check_headroom(force=args.force_headroom or args.from_fixture)
        if args.from_fixture:
            inputs = fixture_inputs(args.fiscal_year)
        else:
            collector = CheckpointedCollector(
                args.output_dir,
                delay_ms=args.polite_delay_ms,
                refresh=args.refresh,
            )
            inputs = live_inputs(args, collector)

        review_file = args.review_file
        if review_file is None:
            review_file = REPO_ROOT / "site" / "data" / "procurement_plan_sources" / "bridge_review_labels.json"
        review_labels = inputs.get("review_labels") or load_review_labels(review_file)
        measurement_plans = inputs.get("measurement_plans") or (inputs["plans"] + inputs["capital"])
        measurement, edges = build_bridge_measurement(
            measurement_plans,
            inputs["targets"],
            sample_size=args.sample_size,
            review_labels=review_labels,
        )
        tables = materialize_warehouse(
            args.output_dir,
            inputs["source_files"],
            inputs["plans"],
            inputs["capital"],
            edges,
        )
        payload = build_payload(
            args,
            inputs["source_files"],
            inputs["plans"],
            inputs["capital"],
            edges,
            generated_at,
        )
        payload_path = args.output_dir / "procurement_planning_payload.json"
        write_json(payload_path, payload)
        public_manifest, _ = build_public_payload_bundle(payload)
        receipt = {
            "schema": "cityscroll.procurement_plans.receipt.v1",
            "proof_scope": "fixture_framework" if args.from_fixture else "production_materialization",
            "production_data_claimed": not args.from_fixture,
            "observed_at": generated_at,
            "fiscal_year": args.fiscal_year,
            "mode": "fixture" if args.from_fixture else "live",
            "sources": {
                "ll63_index": LL63_INDEX,
                "ll1_index": LL1_INDEX,
                "capital_projects_dashboard": CAPITAL_LANDING,
            },
            "collection": {
                "host_side": True,
                "checkpointed": True,
                "conditional_get": True,
                "polite_min_delay_seconds": MINIMUM_DELAY_MS / 1000,
                "user_agent": USER_AGENT,
                "retry_on_403": False,
                "source_files": len(inputs["source_files"]),
                "source_file_counts": {
                    source: sum(1 for item in inputs["source_files"] if item.get("source") == source)
                    for source in ("mocs_ll63", "mocs_ll1", "capital_projects_dashboard")
                },
            },
            "normalization": {
                "mocs_plan_rows": len(inputs["plans"]),
                "capital_project_rows": len(inputs["capital"]),
                "fields": [
                    "agency", "description", "procurement_method", "industry",
                    "term_start", "term_end", "quarter", "budget", "published_identifiers",
                ],
                "honest_absent": True,
            },
            "bridge_targets": inputs["target_receipts"],
            "join_measurement": measurement,
            "warehouse": {
                "catalog": "warehouse/duckdb/cityscroll.duckdb",
                "tables": tables,
                "single_job_lock": True,
                "headroom_gate": True,
                "duckdb_threads": 1,
                "headroom_status": headroom.get("status"),
            },
            "payload_contract": {
                **public_payload_contract(public_manifest),
                "production_materialized": not args.from_fixture,
                "production_bridge_edges": len(edges) if not args.from_fixture else 0,
                "fixture_bridge_edges": len(edges) if args.from_fixture else 0,
            },
        }
        receipt_path = args.output_dir / "procurement_plans_receipt.json"
        write_json(receipt_path, receipt)

        if args.publish:
            site_data = REPO_ROOT / "site" / "data"
            public_payload = site_data / "procurement_planning_payload.json"
            public_receipt = (
                REPO_ROOT / "site" / "data" / "procurement_plan_sources" /
                "verification_receipts" / f"procurement_plans_{args.receipt_date}.json"
            )
            public_payload.parent.mkdir(parents=True, exist_ok=True)
            public_receipt.parent.mkdir(parents=True, exist_ok=True)
            publish_public_payload(payload, site_data)
            shutil.copyfile(receipt_path, public_receipt)
            print(f"published {public_payload.relative_to(REPO_ROOT)}")
            print(f"published {public_receipt.relative_to(REPO_ROOT)}")

    print(json.dumps({
        "plans": len(inputs["plans"]),
        "capital_projects": len(inputs["capital"]),
        "bridge_edges": len(edges),
        "receipt": str(receipt_path),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
