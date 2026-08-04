#!/usr/bin/env python3
"""Guarded host-side collector for NYCIDA/Build NYC project documents."""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from cpu_guard import IngestLock, check_headroom  # noqa: E402
from nycedc_projects import (  # noqa: E402
    dump_json,
    extract_annual_spreadsheet,
    extract_board_minutes,
    extract_board_minutes_text,
    extract_index_documents,
    extract_notice_projects,
    measurement_receipt,
    sha256_bytes,
)
from paths import REPO_ROOT, duckdb_path, raw_dir, receipts_dir  # noqa: E402


CONFIG = REPO_ROOT / "warehouse/nycedc_sources.v1.json"
FIXTURE = REPO_ROOT / "warehouse/fixtures/nycedc-project-documents/sample.json"
REVIEWS = REPO_ROOT / "warehouse/fixtures/nycedc-project-documents/join_review.json"
SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json"
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024


def display_path(path: Path, fallback: str) -> str:
    """Keep machine-local storage roots out of committed receipts."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return fallback


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path, fallback: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")


class Collector:
    def __init__(self, *, user_agent: str, delay_ms: int, checkpoint_path: Path, fixture: bool) -> None:
        self.user_agent = user_agent
        self.delay_s = delay_ms / 1000
        self.checkpoint_path = checkpoint_path
        self.fixture = fixture
        self.checkpoint = read_json(checkpoint_path, {"documents": {}, "indexes": {}})
        self.source_status: list[dict] = []

    def _fetch(self, url: str, *, accept: str, max_bytes: int = MAX_DOCUMENT_BYTES) -> bytes:
        request = Request(url, headers={"User-Agent": self.user_agent, "Accept": accept})
        try:
            with urlopen(request, timeout=60) as response:
                length = int(response.headers.get("content-length") or 0)
                if length > max_bytes:
                    raise RuntimeError(f"document exceeds {max_bytes} bytes: {url}")
                payload = response.read(max_bytes + 1)
        except HTTPError as error:
            if error.code == 403:
                raise RuntimeError(f"publisher refused polite collector (HTTP 403, no retry): {url}") from error
            raise RuntimeError(f"publisher returned HTTP {error.code}: {url}") from error
        except URLError as error:
            raise RuntimeError(f"publisher fetch failed: {url}: {error.reason}") from error
        finally:
            if not self.fixture:
                time.sleep(self.delay_s)
        if len(payload) > max_bytes:
            raise RuntimeError(f"document exceeds {max_bytes} bytes: {url}")
        return payload

    def _save_checkpoint(self) -> None:
        dump_json(self.checkpoint_path, self.checkpoint)

    def discover(self, config: dict, snapshot_dir: Path | None) -> list[dict]:
        documents = list(config.get("seed_documents", []))
        for index in config.get("index_pages", []):
            url = index["url"]
            html_text = None
            mode = "live"
            if snapshot_dir:
                snapshot = snapshot_dir / f"{index['authority']}-{sha256_bytes(url.encode())[:12]}.html"
                if snapshot.exists():
                    html_text = snapshot.read_text(encoding="utf-8")
                    mode = "host_browser_snapshot"
            if html_text is None:
                try:
                    html_text = self._fetch(url, accept="text/html").decode("utf-8", errors="replace")
                except RuntimeError as error:
                    previous = self.checkpoint["indexes"].get(url, {})
                    cached_documents = previous.get("documents", [])
                    documents.extend(cached_documents)
                    self.source_status.append(
                        {
                            "url": url,
                            "status": "blocked",
                            "error": str(error),
                            "cached_documents": len(cached_documents),
                            "last_good_at": previous.get("last_good_at"),
                        }
                    )
                    self.checkpoint["indexes"][url] = {
                        **previous,
                        "last_attempt_at": utc_now(),
                        "last_attempt_status": "blocked",
                    }
                    self._save_checkpoint()
                    continue
            content_hash = sha256_bytes(html_text.encode())
            found = extract_index_documents(html_text, url, index["authority"])
            documents.extend(found)
            snapshot = self.checkpoint_path.parent / "indexes" / f"{content_hash}.html"
            snapshot.parent.mkdir(parents=True, exist_ok=True)
            snapshot.write_text(html_text, encoding="utf-8")
            observed_at = utc_now()
            self.source_status.append(
                {
                    "url": url,
                    "status": "ok",
                    "mode": mode,
                    "content_sha256": content_hash,
                    "documents": len(found),
                }
            )
            self.checkpoint["indexes"][url] = {
                "last_good_at": observed_at,
                "last_attempt_at": observed_at,
                "last_attempt_status": "ok",
                "content_sha256": content_hash,
                "snapshot": display_path(snapshot, "external index snapshot override"),
                "documents": found,
            }
            self._save_checkpoint()
        by_url = {}
        for row in documents:
            by_url[row["source_url"]] = row
        return list(by_url.values())

    def acquire(self, document: dict, destination: Path) -> tuple[dict, Path]:
        url = document["source_url"]
        suffix = Path(url.split("?", 1)[0]).suffix.lower() or ".bin"
        name = f"{sha256_bytes(url.encode())[:20]}{suffix}"
        path = destination / name
        cached = self.checkpoint["documents"].get(url)
        if path.exists() and cached and cached.get("content_sha256"):
            payload = path.read_bytes()
            content_hash = sha256_bytes(payload)
            if content_hash == cached["content_sha256"]:
                return {**document, "content_sha256": content_hash, "observed_at": cached["observed_at"], "bytes": len(payload), "acquisition_status": "acquired"}, path
        payload = self._fetch(url, accept="application/pdf, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*")
        destination.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        content_hash = sha256_bytes(payload)
        observed_at = utc_now()
        self.checkpoint["documents"][url] = {
            "observed_at": observed_at,
            "content_sha256": content_hash,
            "bytes": len(payload),
            "path": str(path.relative_to(REPO_ROOT)),
        }
        self._save_checkpoint()
        return {**document, "content_sha256": content_hash, "observed_at": observed_at, "bytes": len(payload), "acquisition_status": "acquired"}, path


def fetch_fixed_notices(config: dict, user_agent: str) -> list[dict]:
    ids = config["fixed_notice_request_ids"]
    fields = [
        "request_id",
        "start_date",
        "event_date",
        "agency_name",
        "short_title",
        "additional_description_1",
        "additional_description_2",
        "additional_description_3",
        "other_info_1",
        "other_info_2",
        "other_info_3",
    ]
    quoted = ",".join(f'"{request_id}"' for request_id in ids)
    query = urlencode(
        {
            "$select": ",".join(fields),
            "$where": f"request_id in ({quoted})",
            "$order": "request_id",
            "$limit": str(len(ids)),
        }
    )
    request = Request(f"{SODA}?{query}", headers={"User-Agent": user_agent, "Accept": "application/json"})
    with urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def materialize(documents: list[dict], projects: list[dict], edges: list[dict]) -> dict:
    try:
        import duckdb
    except ImportError:
        return {"skipped": True, "reason": "duckdb_unavailable"}
    root = raw_dir("nycedc-project-documents", "daily")
    docs_path = root / "documents.jsonl"
    projects_path = root / "projects.jsonl"
    edges_path = root / "notice_edges.jsonl"
    write_jsonl(docs_path, documents)
    write_jsonl(projects_path, projects)
    write_jsonl(edges_path, edges)
    db_path = duckdb_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(db_path))
    try:
        for table, path, empty_sql in (
            (
                "nycedc_documents",
                docs_path,
                "CREATE TABLE nycedc_documents(authority VARCHAR, document_type VARCHAR, title VARCHAR, source_url VARCHAR, index_url VARCHAR, content_sha256 VARCHAR, observed_at VARCHAR, bytes BIGINT, acquisition_status VARCHAR)",
            ),
            (
                "nycedc_projects",
                projects_path,
                "CREATE TABLE nycedc_projects(schema VARCHAR, authority VARCHAR, project_id VARCHAR, project_name VARCHAR, company VARCHAR, address VARCHAR, request_id VARCHAR, requested_benefit DOUBLE, estimated_public_cost DOUBLE, project_cost DOUBLE, milestones JSON, provenance JSON)",
            ),
            (
                "nycedc_project_notice_edges",
                edges_path,
                "CREATE TABLE nycedc_project_notice_edges(notice_project_key VARCHAR, request_id VARCHAR, project_id VARCHAR, project_name VARCHAR, method VARCHAR, confidence DOUBLE, evidence JSON, source_url VARCHAR)",
            ),
        ):
            connection.execute(f"DROP TABLE IF EXISTS {table}")
            if path.exists() and path.stat().st_size:
                connection.execute(
                    f"CREATE TABLE {table} AS SELECT * FROM read_json_auto(?, format='newline_delimited')",
                    [str(path)],
                )
            else:
                connection.execute(empty_sql)
        connection.execute("DROP VIEW IF EXISTS nycedc_project_feed")
        connection.execute(
            """CREATE VIEW nycedc_project_feed AS
               SELECT p.*, e.request_id AS joined_request_id, e.method AS join_method,
                      e.confidence AS join_confidence
               FROM nycedc_projects p
               LEFT JOIN nycedc_project_notice_edges e USING (project_id)"""
        )
    finally:
        connection.close()
    return {
        "database": display_path(db_path, "external warehouse database override"),
        "tables": ["nycedc_documents", "nycedc_projects", "nycedc_project_notice_edges"],
        "view": "nycedc_project_feed",
        "single_job_lock": True,
        "headroom_gate": True,
    }


def fixture_inputs(payload: dict) -> tuple[list[dict], list[dict], list[dict]]:
    observed_at = payload["observed_at"]
    documents = []
    projects = []
    for raw in payload["documents"]:
        body = raw["text"].encode()
        document = {
            "authority": raw["authority"],
            "document_type": raw["document_type"],
            "title": raw["title"],
            "source_url": raw["source_url"],
            "index_url": raw["index_url"],
            "content_sha256": sha256_bytes(body),
            "observed_at": observed_at,
            "bytes": len(body),
            "acquisition_status": "fixture",
        }
        documents.append(document)
        projects.extend(extract_board_minutes_text(raw["text"], document))
    for row in payload.get("spreadsheet_projects", []):
        projects.append(row)
    notice_projects = [project for notice in payload["notices"] for project in extract_notice_projects(notice)]
    return documents, projects, notice_projects


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NYCIDA/Build NYC project-document collector")
    parser.add_argument("--from-fixture", action="store_true")
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--polite-delay-ms", type=int)
    parser.add_argument("--snapshot-dir", type=Path)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--force-headroom", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.limit <= 50:
        raise SystemExit("--limit must be 1..50")
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    delay_ms = args.polite_delay_ms or int(config["polite_delay_ms"])
    if not args.from_fixture and delay_ms < 1200:
        raise SystemExit("live publisher cadence must be at least 1200 ms")
    checkpoint = args.checkpoint or raw_dir("nycedc-project-documents", "daily") / "checkpoint.json"
    receipt_path = args.receipt or receipts_dir() / (
        "proof/rc2_nycedc_project_documents_latest.json" if args.from_fixture else "nycedc_project_documents_latest.json"
    )

    with IngestLock():
        check_headroom(force=args.force_headroom or args.from_fixture)
        if args.from_fixture:
            fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
            documents, projects, notice_projects = fixture_inputs(fixture)
            reviews = fixture["reviews"]
            source_status = [{"url": row["index_url"], "status": "fixture"} for row in documents]
            observed_at = fixture["observed_at"]
        else:
            collector = Collector(
                user_agent=config["user_agent"],
                delay_ms=delay_ms,
                checkpoint_path=checkpoint,
                fixture=False,
            )
            discovered = collector.discover(config, args.snapshot_dir)
            documents = []
            indexed_documents = [
                {
                    **item,
                    "content_sha256": None,
                    "observed_at": utc_now(),
                    "bytes": None,
                    "acquisition_status": "indexed",
                }
                for item in discovered
                if item["document_type"] in {"project_document", "project_document_index"}
            ]
            projects = []
            destination = raw_dir("nycedc-project-documents", datetime.now().date().isoformat()) / "documents"
            for item in discovered:
                if len(documents) >= args.limit:
                    break
                if item["document_type"] not in {"board_minutes", "annual_project_spreadsheet"}:
                    continue
                try:
                    document, path = collector.acquire(item, destination)
                except RuntimeError as error:
                    collector.source_status.append({"url": item["source_url"], "status": "error", "error": str(error)})
                    continue
                documents.append(document)
                if item["document_type"] == "board_minutes":
                    projects.extend(extract_board_minutes(path, document))
                elif item["document_type"] == "annual_project_spreadsheet":
                    projects.extend(extract_annual_spreadsheet(path, document))
            notices = fetch_fixed_notices(config, config["user_agent"])
            notice_projects = [project for notice in notices for project in extract_notice_projects(notice)]
            reviews = json.loads(REVIEWS.read_text(encoding="utf-8"))["reviews"]
            source_status = collector.source_status
            observed_at = utc_now()

        if args.from_fixture:
            indexed_documents = []

        receipt, accepted_edges = measurement_receipt(
            notice_projects=notice_projects,
            source_projects=projects,
            reviews=reviews,
            documents=documents,
            observed_at=observed_at,
        )
        warehouse = materialize(documents + indexed_documents, projects, accepted_edges)
        receipt.update(
            {
                "mode": "fixture" if args.from_fixture else "live",
                "collector": {
                    "host_side": True,
                    "checkpoint": display_path(checkpoint, "external checkpoint override"),
                    "polite_delay_ms": 0 if args.from_fixture else delay_ms,
                    "honest_user_agent": config["user_agent"],
                    "index_403_policy": "one attempt; record blocked; no retry",
                    "source_status": source_status,
                },
                "counts": {
                    "documents": len(documents),
                    "indexed_project_documents": len(indexed_documents),
                    "projects": len(projects),
                    "notice_project_mentions": len(notice_projects),
                    "materialized_edges": len(accepted_edges),
                },
                "warehouse": warehouse,
                "payload_contract": "warehouse/schemas/nycedc_project_feed.v1.schema.json",
            }
        )
        dump_json(receipt_path, receipt)
        print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
