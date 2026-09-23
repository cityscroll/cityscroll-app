#!/usr/bin/env python3
"""Capture the live production read-back for the five Near You borough fixtures.

Each canonical residential fixture route is read from the deployed origins and
classified into exactly one typed published coverage state: available records,
published zero, unavailable source coverage, or transient publication failure.
The classification is asserted against the state the live read-back receipt
expects, so the capture itself is the test: a fabricated zero or a generic
unavailable fails the run. The served page is then rendered in headless
Chromium at desktop and mobile widths to prove the typed state is what a
resident sees. Only hashes and the redacted schema/state/count fields are
retained; screenshot binaries are not written.

Usage:
  python3 tools/capture_near_you_place_slices_production_read.py
  python3 tools/capture_near_you_place_slices_production_read.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
RECEIPT = ROOT / "docs/evidence/near-you-place-slices/live-readback-receipt.json"
OUTPUT = ROOT / "docs/evidence/near-you-place-slices/production-read.json"
SCHEMA = "cityscroll.near_you_place_slices_production_read.v1"
ORIGIN = "https://cityscroll.org"
API_ORIGIN = "https://api.cityscroll.org"
USER_AGENT = "CityScrollEvidence/1.0 (+https://cityscroll.org)"
VIEWPORTS = (("desktop", 1440, 900), ("mobile", 390, 844))

ZERO_COPY = "No records match these filters."
UNAVAILABLE_COPY = "This area\u2019s materialized records are unavailable right now."
GENERIC_UNAVAILABLE_COPY = "Matching records are not available right now."
DEFERRED_SCHEMA = "cityscroll.near_you_deferred.v1"
DEFERRED_ERROR_SCHEMA = "cityscroll.near_you_deferred_error.v1"

# Served classification for each locally published coverage state.
SERVED_STATE_BY_COVERAGE = {
    "ready": "available_records",
    "zero": "published_zero",
    "source_unavailable": "unavailable_source_coverage",
}


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(f"{json.dumps(payload, indent=2, ensure_ascii=False)}\n", encoding="utf-8")


def assertions_digest(assertions: list[dict[str, Any]]) -> str:
    # Canonical convention: sha256 over the compact JSON of the assertions
    # array plus a trailing newline, matching the receipt tests.
    return sha256(json.dumps(assertions, separators=(",", ":"), ensure_ascii=False) + "\n")


def uncached_url(origin: str, route: str, token: str | None = None) -> str:
    separator = "&" if "?" in route else "?"
    cache_token = token or secrets.token_hex(12)
    return f"{origin}{route}{separator}_cityscroll_evidence={cache_token}"


def fetch(origin: str, route: str, accept: str = "application/json") -> tuple[int, bytes]:
    request = urllib.request.Request(
        uncached_url(origin, route),
        headers={
            "Accept": accept,
            "Cache-Control": "no-cache, no-store",
            "Pragma": "no-cache",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def fetch_json(origin: str, route: str) -> tuple[int, bytes, Any]:
    status, body = fetch(origin, route)
    return status, body, json.loads(body)


def classify_deferred(status: int, payload: Any) -> dict[str, Any]:
    """Reduce a deferred payload to its typed published coverage state.

    Returns the served state, the exact-record count when one is published,
    and the typed-copy evidence. Anything outside the four typed states is a
    capture failure, never a silent reclassification.
    """
    if status == 503 and isinstance(payload, dict) and payload.get("schema") == DEFERRED_ERROR_SCHEMA:
        return {
            "state": "transient_publication_failure",
            "count": None,
            "typed_copy": None,
            "reason": payload.get("reason"),
        }
    if status != 200:
        raise AssertionError(f"deferred read returned unexpected HTTP {status}")
    if not isinstance(payload, dict) or payload.get("schema") != DEFERRED_SCHEMA:
        raise AssertionError(f"deferred read returned unexpected schema {payload.get('schema') if isinstance(payload, dict) else type(payload)}")
    results_html = payload.get("results_html")
    if not isinstance(results_html, str):
        raise AssertionError("deferred read has no results_html")
    count_match = re.search(r'data-results-count="(\d+)"', results_html)
    if count_match:
        count = int(count_match.group(1))
        if count > 0:
            if "<ol class=\"near-records\">" not in results_html:
                raise AssertionError("positive count without a rendered record list")
            return {"state": "available_records", "count": count, "typed_copy": None}
        if ZERO_COPY not in results_html:
            raise AssertionError("zero count without the published-zero copy")
        return {"state": "published_zero", "count": 0, "typed_copy": ZERO_COPY}
    if UNAVAILABLE_COPY in results_html:
        if GENERIC_UNAVAILABLE_COPY in results_html or ZERO_COPY in results_html:
            raise AssertionError("unavailable source coverage mixed with generic or zero copy")
        return {"state": "unavailable_source_coverage", "count": None, "typed_copy": UNAVAILABLE_COPY}
    raise AssertionError("deferred read matches no typed published coverage state")


def page_assertion_for(state: str) -> dict[str, str]:
    if state == "available_records":
        return {
            "selector": "section.near-results .near-record",
            "expect": "records",
        }
    if state == "published_zero":
        return {"selector": "section.near-results .near-empty", "expect": "zero_copy"}
    if state == "unavailable_source_coverage":
        return {"selector": "section.near-results .near-empty", "expect": "unavailable_copy"}
    raise AssertionError(f"no page assertion for served state {state}")


def capture() -> dict[str, Any]:
    origin = ORIGIN
    receipt = read_json(RECEIPT)
    fixtures = receipt["fixtures"]
    expected = {row["id"]: SERVED_STATE_BY_COVERAGE[row["expected_local_coverage"]] for row in fixtures}

    manifest_status, manifest_bytes, manifest = fetch_json(origin, "/artifact-manifest.json")
    if manifest_status != 200:
        raise AssertionError("artifact manifest did not return HTTP 200")
    revision = manifest.get("source_commit_sha")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise AssertionError("served artifact manifest has no commit revision")
    health_status, _health_bytes, health = fetch_json(API_ORIGIN, "/health")
    if health_status != 200:
        raise AssertionError("worker health did not return HTTP 200")
    worker_commit = health.get("commit")
    if not isinstance(worker_commit, str) or not re.fullmatch(r"[0-9a-f]{40}", worker_commit):
        raise AssertionError("worker health has no serving commit")

    reads: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser_version = browser.version
        for fixture in fixtures:
            fixture_id = fixture["id"]
            route = fixture["route"]
            expected_state = expected[fixture_id]

            status, body, payload = fetch_json(origin, route)
            classification = classify_deferred(status, payload)
            if classification["state"] != expected_state:
                raise AssertionError(
                    f"{fixture_id}: served {classification['state']} != expected {expected_state}"
                )

            page_route = (
                f"/near-you/?geo=nta2020%3A{fixture_id}&lens=meetings&surface=records"
            )
            page_assertion = page_assertion_for(expected_state)
            viewport_reads: list[dict[str, Any]] = []
            route_token = secrets.token_hex(12)
            for viewport_name, width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    extra_http_headers={
                        "Cache-Control": "no-cache, no-store",
                        "Pragma": "no-cache",
                    },
                )
                page = context.new_page()
                response = page.goto(
                    uncached_url(origin, page_route, route_token),
                    wait_until="networkidle",
                    timeout=90_000,
                )
                page.wait_for_selector(
                    "section.near-results .near-record, section.near-results .near-empty",
                    timeout=90_000,
                )
                page.wait_for_timeout(150)
                page_status = response.status if response else None
                if page_status != 200:
                    raise AssertionError(f"{page_route} returned HTTP {page_status} at {viewport_name}")
                observed = page.evaluate(
                    """([selector, zeroCopy, unavailableCopy]) => {
                      const results = document.querySelector('section.near-results');
                      const records = results ? results.querySelectorAll('.near-record').length : 0;
                      const copyNode = results ? results.querySelector(selector) : null;
                      const copy = copyNode ? copyNode.textContent.replace(/\\s+/g, ' ').trim() : null;
                      const heading = results
                        ? (results.querySelector('#near-results-heading')?.textContent || '').replace(/\\s+/g, ' ').trim()
                        : null;
                      return {
                        records,
                        copy,
                        heading,
                        zero_seen: !!results && results.textContent.includes(zeroCopy),
                        unavailable_seen: !!results && results.textContent.includes(unavailableCopy),
                        generic_seen: !!results && results.textContent.includes('Matching records are not available right now.'),
                      };
                    }""",
                    [page_assertion["selector"], ZERO_COPY, UNAVAILABLE_COPY],
                )
                if expected_state == "available_records":
                    if observed["records"] < 1 or observed["records"] != classification["count"]:
                        raise AssertionError(
                            f"{fixture_id} {viewport_name}: rendered {observed['records']} records, deferred count {classification['count']}"
                        )
                elif expected_state == "published_zero":
                    if not observed["zero_seen"] or observed["records"] != 0:
                        raise AssertionError(f"{fixture_id} {viewport_name}: published zero not rendered honestly")
                else:
                    if not observed["unavailable_seen"] or observed["zero_seen"] or observed["generic_seen"]:
                        raise AssertionError(
                            f"{fixture_id} {viewport_name}: typed source-coverage copy not rendered distinctly"
                        )
                    if observed["records"] != 0:
                        raise AssertionError(f"{fixture_id} {viewport_name}: unavailable state rendered records")
                layout = page.evaluate(
                    """() => ({
                      scroll_width: document.documentElement.scrollWidth,
                      client_width: document.documentElement.clientWidth,
                      inner_width: window.innerWidth,
                    })"""
                )
                if layout["scroll_width"] != layout["client_width"]:
                    raise AssertionError(f"{page_route} has horizontal overflow at {viewport_name}")
                markup = page.content()
                screenshot = page.screenshot(full_page=True)
                witness = {
                    "fixture": fixture_id,
                    "state": expected_state,
                    "records": observed["records"],
                    "copy": observed["copy"],
                    "heading": observed["heading"],
                    "layout": layout,
                    "title": page.title(),
                }
                viewport_reads.append({
                    "name": viewport_name,
                    "width": width,
                    "height": height,
                    "http_status": page_status,
                    "rendered_state": expected_state,
                    "rendered_record_count": observed["records"],
                    "rendered_copy": observed["copy"],
                    "no_horizontal_overflow": True,
                    "page_html_sha256": sha256(markup),
                    "screenshot_sha256": sha256(screenshot),
                    "witness_sha256": sha256(json.dumps(witness, sort_keys=True, separators=(",", ":"))),
                    "result": "pass",
                })
                context.close()

            reads.append({
                "fixture": fixture_id,
                "label": fixture["label"],
                "route": route,
                "url": f"{origin}{route}",
                "http_status": status,
                "schema": payload.get("schema"),
                "served_state": classification["state"],
                "count": classification["count"],
                "typed_copy": classification["typed_copy"],
                "deferred_response_sha256": sha256(body),
                "page_route": page_route,
                "viewports": viewport_reads,
                "result": "pass",
            })
        browser.close()

    final_status, final_manifest_bytes, _ = fetch_json(origin, "/artifact-manifest.json")
    if final_status != 200 or final_manifest_bytes != manifest_bytes:
        raise AssertionError("served deployment changed during production read-back capture")

    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    readback_by_fixture = {read["fixture"]: read for read in reads}
    receipt_out = read_json(RECEIPT)
    for fixture in receipt_out["fixtures"]:
        read = readback_by_fixture[fixture["id"]]
        fixture["production_readback"] = {
            "observed_at": observed_at,
            "http_status": read["http_status"],
            "schema": read["schema"],
            "served_state": read["served_state"],
            "count": read["count"],
            "deferred_response_sha256": read["deferred_response_sha256"],
            "deployment_revision": revision,
            "worker_commit": worker_commit,
            "result": "pass",
        }
    receipt_out["status"] = "recorded"
    for row in receipt_out["assertions"]:
        if row["id"] == "production-five-fixture-readback":
            row["result"] = "accepted"
    receipt_out["assertions_sha256"] = assertions_digest(receipt_out["assertions"])
    write_json(RECEIPT, receipt_out)

    return {
        "schema": SCHEMA,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": origin,
        "api_origin": API_ORIGIN,
        "deployment": {
            "manifest_url": f"{origin}/artifact-manifest.json",
            "revision": revision,
            "generated_at": manifest.get("generated_at"),
            "deployment_at": manifest.get("deployment_at"),
            "artifact_hash": manifest.get("artifact_hash"),
            "manifest_sha256": sha256(manifest_bytes),
        },
        "worker": {
            "health_url": f"{API_ORIGIN}/health",
            "commit": worker_commit,
            "environment": health.get("environment"),
        },
        "capture": {
            "tool": "tools/capture_near_you_place_slices_production_read.py",
            "browser": f"chromium {browser_version}",
            "viewports": [
                {"name": name, "width": width, "height": height}
                for name, width, height in VIEWPORTS
            ],
            "screenshot_binaries_committed": False,
        },
        "redaction": "Deferred response bodies are reduced to schema, typed state, count, and a body hash; no record fields are retained.",
        "typed_states": [
            "available_records",
            "published_zero",
            "unavailable_source_coverage",
            "transient_publication_failure",
        ],
        "reads": reads,
        "summary": {
            "result": "pass",
            "fixtures_observed": len(reads),
            "viewport_observations": sum(len(read["viewports"]) for read in reads),
        },
    }


def validate(production_read: dict[str, Any], receipt: dict[str, Any]) -> None:
    if production_read.get("schema") != SCHEMA:
        raise AssertionError("production read-back schema mismatch")
    if production_read.get("origin") != ORIGIN or production_read.get("api_origin") != API_ORIGIN:
        raise AssertionError("production read-back is not from the canonical production origins")
    if production_read.get("deployment", {}).get("manifest_url") != f"{ORIGIN}/artifact-manifest.json":
        raise AssertionError("production read-back deployment manifest is not canonical")
    revision = production_read.get("deployment", {}).get("revision", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise AssertionError("production read-back has no deployment revision")
    worker_commit = production_read.get("worker", {}).get("commit", "")
    if not re.fullmatch(r"[0-9a-f]{40}", worker_commit):
        raise AssertionError("production read-back has no worker commit")

    fixtures = receipt.get("fixtures", [])
    if [row.get("id") for row in fixtures] != ["BK0101", "QN0103", "SI0101", "MN0102", "BX0101"]:
        raise AssertionError("live read-back receipt lost a borough fixture")
    reads = production_read.get("reads", [])
    if [read.get("fixture") for read in reads] != [row["id"] for row in fixtures]:
        raise AssertionError("production read-back does not cover the five borough fixtures")
    if receipt.get("status") != "recorded":
        raise AssertionError("live read-back receipt is not recorded")
    if production_read.get("summary") != {
        "result": "pass",
        "fixtures_observed": 5,
        "viewport_observations": 10,
    }:
        raise AssertionError("production read-back summary is incomplete")

    for fixture, read in zip(fixtures, reads):
        expected_state = SERVED_STATE_BY_COVERAGE[fixture["expected_local_coverage"]]
        if read.get("result") != "pass" or read.get("served_state") != expected_state:
            raise AssertionError(f"{read.get('fixture')} served state mismatch")
        if read.get("http_status") != 200 or read.get("schema") != DEFERRED_SCHEMA:
            raise AssertionError(f"{read.get('fixture')} deferred response is not the typed schema")
        if not re.fullmatch(r"[0-9a-f]{64}", read.get("deferred_response_sha256", "")):
            raise AssertionError(f"{read.get('fixture')} has no deferred body hash")
        if expected_state == "available_records" and not (isinstance(read.get("count"), int) and read["count"] > 0):
            raise AssertionError(f"{read.get('fixture')} available records without a positive count")
        if expected_state == "published_zero" and read.get("count") != 0:
            raise AssertionError(f"{read.get('fixture')} published zero without a zero count")
        if expected_state == "unavailable_source_coverage" and read.get("count") is not None:
            raise AssertionError(f"{read.get('fixture')} unavailable source coverage carried a fabricated count")
        if expected_state in ("published_zero", "unavailable_source_coverage") and not read.get("typed_copy"):
            raise AssertionError(f"{read.get('fixture')} typed copy was not recorded")
        if [(item.get("name"), item.get("width"), item.get("height")) for item in read.get("viewports", [])] != list(VIEWPORTS):
            raise AssertionError(f"{read.get('fixture')} viewport coverage mismatch")
        for viewport in read["viewports"]:
            if viewport.get("http_status") != 200 or viewport.get("result") != "pass":
                raise AssertionError(f"{read.get('fixture')} {viewport.get('name')} did not pass")
            if viewport.get("rendered_state") != expected_state:
                raise AssertionError(f"{read.get('fixture')} {viewport.get('name')} rendered a different state")
            if viewport.get("no_horizontal_overflow") is not True:
                raise AssertionError(f"{read.get('fixture')} {viewport.get('name')} overflowed")
            for field in ("page_html_sha256", "screenshot_sha256", "witness_sha256"):
                if not re.fullmatch(r"[0-9a-f]{64}", viewport.get(field, "")):
                    raise AssertionError(f"{read.get('fixture')} {viewport.get('name')} has no {field}")

        readback = fixture.get("production_readback")
        if not isinstance(readback, dict) or readback.get("result") != "pass":
            raise AssertionError(f"{fixture['id']} receipt read-back is not populated")
        if readback.get("served_state") != read["served_state"] or readback.get("count") != read["count"]:
            raise AssertionError(f"{fixture['id']} receipt read-back diverges from the production read")
        if readback.get("deferred_response_sha256") != read["deferred_response_sha256"]:
            raise AssertionError(f"{fixture['id']} receipt read-back hash diverges from the production read")
        if readback.get("deployment_revision") != revision or readback.get("worker_commit") != worker_commit:
            raise AssertionError(f"{fixture['id']} receipt read-back lost its deployment identity")

    assertion = next((row for row in receipt.get("assertions", []) if row.get("id") == "production-five-fixture-readback"), None)
    if not assertion or assertion.get("result") != "accepted":
        raise AssertionError("production five-fixture read-back assertion is not accepted")
    if receipt.get("assertions_sha256") != assertions_digest(receipt["assertions"]):
        raise AssertionError("live read-back receipt assertion digest is stale")
    for artifact in (production_read, receipt):
        serialized = json.dumps(artifact)
        if "/Users/" in serialized or "file://" in serialized:
            raise AssertionError("evidence artifact contains a local path reference")


def check() -> None:
    validate(read_json(OUTPUT), read_json(RECEIPT))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        print(f"near-you place-slices production read-back passed: {OUTPUT.relative_to(ROOT)}")
        return 0
    receipt = capture()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    write_json(OUTPUT, receipt)
    print(f"wrote {OUTPUT.relative_to(ROOT)} summary={receipt['summary']['result']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
