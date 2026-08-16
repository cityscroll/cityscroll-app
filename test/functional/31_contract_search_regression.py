#!/usr/bin/env python3
"""Universal contract SearchDocuments restore award queries beyond the bounded snapshot."""

from __future__ import annotations

import json
import os
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://localhost:8000/").rstrip("/")
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
            "**/crol-worker.crol-worker.workers.dev/**",
        ):
            context.route(pattern, first_party)

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
