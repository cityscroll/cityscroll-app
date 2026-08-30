#!/usr/bin/env python3
"""Universal contract SearchDocuments restore award queries beyond the bounded snapshot."""

from __future__ import annotations

import json
import os
import pathlib
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://localhost:8000/").rstrip("/")
ROOT = pathlib.Path(__file__).parents[2]
QUERY_FIELDS = (
    "procurement_id", "canonical_href", "procurement_stages", "primary_stage",
    "request_id", "start_date", "due_date", "agency_name", "short_title", "pin",
    "contract_id", "contract_amount", "vendor_name", "selection_method_description",
    "category_description", "type_of_notice_description", "source_system",
    "method_family", "procurement_category", "coverage_state", "additional_description_1",
    "project_id", "project_name",
)
CASES = {
    "mosquito": {
        "pin": "02EA43001R0X00",
        "request_id": "20030520019",
        "title": "Aerial Mosquito Control",
        "source_family": "ocp-recent-contract-awards",
        "browse_record": {
            "request_id": "20030520019",
            "start_date": "2003-05-27",
            "agency_name": "Health and Mental Hygiene",
            "type_of_notice_description": "Award",
            "short_title": "Aerial Mosquito Control",
            "pin": "02EA43001R0X00",
            "contract_amount": "4294050",
            "vendor_name": "Agrotors, Inc.",
            "source_system": "ocp-recent-contract-awards",
        },
    },
    "05626S0012": {
        "pin": "05626S0012",
        "request_id": "20260807032",
        "title": "Fixed Wing aircraft program management support services.",
        "source_family": "city_record_notice",
    },
    "05626W0023001": {
        "pin": "05626W0023001",
        "request_id": "20260731016",
        "title": "Fire Alarm Maintenance and Repair for Manhattan and Bronx",
        "source_family": "city_record_notice",
    },
}


def search_document(case: dict[str, object]) -> dict[str, object]:
    pin = str(case["pin"])
    request_id = str(case["request_id"])
    source_family = str(case["source_family"])
    prefix = "ocp_award" if source_family == "ocp-recent-contract-awards" else "notice"
    provenance: dict[str, object] = {
        "producer": (
            "contract_award_search_document.v1"
            if prefix == "ocp_award"
            else "city_record_search_document.v1"
        )
    }
    if case.get("browse_record"):
        provenance["browse_record"] = case["browse_record"]
    return {
        "schema": "cityscroll.search_document.v1",
        "object_ref": f"procurement:{pin}",
        "object_type": "procurement",
        "domain": "contracts",
        "canonical_href": f"/browse/contracts/?mode=award&q={pin}",
        "title": case["title"],
        "summary": f"Public contract award {pin}",
        "search_text": f"{case['title']} {pin} contract award",
        "source_family": source_family,
        "source_observation_refs": [f"{prefix}:{request_id}"],
        "process_role": "award",
        "classification": {
            "method": "exact_procurement_identifier",
            "basis": "stable publisher contract identifier",
        },
        "provenance": provenance,
        "outcome": "indexed",
        "coverage_state": "matched",
    }


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()

        def local_bounded_procurement_query(route: Route) -> None:
            """Provide the Pages query projection when a checkout lacks its ignored artifact.

            The local site server serves the complete legacy payload when the Pages-build
            artifact is absent. That fallback is intentionally not queryable before paint,
            so this test must supply the same filterable manifest that deploys serve while
            leaving the SearchDocument route as the source of the beyond-snapshot award.
            """
            base = urlparse(BASE)
            if base.hostname not in {"localhost", "127.0.0.1", "::1"}:
                route.fallback()
                return
            response = route.fetch()
            if response.ok:
                route.fulfill(response=response)
                return
            browse = json.loads((ROOT / "site" / "data" / "procurement_browse_rows.json").read_text())
            rows = browse.get("rows", []) if isinstance(browse, dict) else []
            manifest = {
                "schema": "cityscroll.procurement_browse_query.v1",
                "version": 1,
                "source_model_schema": browse.get("source_model_schema") if isinstance(browse, dict) else None,
                "generated_at": browse.get("generated_at") if isinstance(browse, dict) else None,
                "source_model_fingerprint": "contract-search-regression-legacy-fallback-v1",
                "query_fields": QUERY_FIELDS,
                "query_rows": [
                    {field: row[field] for field in QUERY_FIELDS if field in row}
                    for row in rows
                ],
                "row_count": len(rows),
                "shards": [],
                "row_shard_by_id": {},
            }
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(manifest),
            )

        def first_party(route: Route) -> None:
            parsed = urlparse(route.request.url)
            if parsed.path == "/search":
                query = parse_qs(parsed.query).get("q", [""])[0]
                case = CASES.get(query)
                body = {"results": [search_document(case)] if case else []}
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    headers={"Access-Control-Allow-Origin": "*"},
                    body=json.dumps(body),
                )
                return
            route.fulfill(status=503, content_type="application/json", body='{"ok":false}')

        for pattern in (
            "**/api.cityscroll.org/**",
            "**/api.crol-list.org/**",
            "**/cityscroll-worker.crol-worker.workers.dev/**",
        ):
            context.route(pattern, first_party)
        context.route("**/data/procurement_browse_query.json", local_bounded_procurement_query)

        for query, case in CASES.items():
            page = context.new_page()
            page.goto(
                f"{BASE}/browse/contracts/?mode=award&q={query}",
                wait_until="domcontentloaded",
                timeout=30_000,
            )
            page.locator("#list .money-row-card").first.wait_for(state="visible", timeout=30_000)
            body = page.locator("#list").inner_text()
            assert str(case["title"]) in body, (query, body)
            assert f"PIN {case['pin']}" in body, (query, body)
            assert "Nothing found" not in body, (query, body)
            page.close()

        browser.close()

    print("PASS: mosquito and both current PINs render through the Contracts award query path")


if __name__ == "__main__":
    main()
