#!/usr/bin/env python3
"""Contracts Browse is a scoped form factor of one federated search capability.

Two properties are checked here.

1. Universal contract SearchDocuments restore award queries beyond the bounded
   snapshot (the original regression: three PINs that the snapshot alone loses).
2. Browse and the scoped capability answer the same question. The request Browse
   issues is the registered Contracts scope, the rows it renders are the
   documents the capability returned in the order it ranked them, and its
   coverage, provenance and freshness are the capability's own receipt. A
   provider failure stays a disclosed failure instead of arriving as a city that
   awarded nothing.
"""

from __future__ import annotations

import json
import os
import pathlib
from urllib.parse import parse_qs, quote, urlparse

from playwright.sync_api import Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://localhost:8000/").rstrip("/")
ROOT = pathlib.Path(__file__).parents[2]
# The registered Contracts scope. Browse must request exactly these lenses, and
# the worker's Contracts lane must be built from the same registered entry.
SCOPE_LENSES = ("notices", "vendors")
ALL_LENSES = (
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
)
CAPABILITY_REFERENCE = "search.federated@1"
RESULT_BOUND = 40
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
            "selection_method_description": "Competitive Sealed Bid",
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
# A second document for the same query, so rank order is observable rather than
# assumed from a single-result fixture.
RANKED_QUERY = "aircraft"
RANKED_CASES = ("05626S0012", "05626W0023001")


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


def coverage_receipt(scope_state: str, as_of: str | None = "2026-09-01") -> dict[str, object]:
    """A scoped coverage receipt: requested lenses answer, the rest are out of scope."""
    by_lens = {}
    for lens in ALL_LENSES:
        if lens in SCOPE_LENSES:
            by_lens[lens] = {
                "state": scope_state,
                "as_of": as_of,
                "indexed_count": None,
                "reason": None,
            }
        else:
            by_lens[lens] = {"state": "out_of_scope", "as_of": None, "indexed_count": None}
    return {"schema": "cityscroll.universal_search_coverage.v1", "by_lens": by_lens}


def scoped_response(documents, *, scope_state="matched", as_of="2026-09-01") -> dict[str, object]:
    coverage = coverage_receipt(scope_state, as_of)
    return {
        "schema": "cityscroll.universal_search_response.v1",
        "capability_reference": CAPABILITY_REFERENCE,
        "results": documents,
        "federated": {
            "schema": "cityscroll.universal_search_federator.v1",
            "coverage": coverage,
            "requested_scope": {
                "schema": "cityscroll.universal_search_requested_scope.v1",
                "omitted": False,
                "mode": "allowlisted",
                "lenses": list(SCOPE_LENSES),
                "by_lens": {
                    lens: {
                        "requested": lens in SCOPE_LENSES,
                        "state": coverage["by_lens"][lens]["state"],
                    }
                    for lens in ALL_LENSES
                },
            },
        },
    }


class CapabilityFixture:
    """The scoped capability, recorded and switchable.

    Every /search request Browse issues is captured, so the test can assert what
    Browse asked as well as what it rendered.
    """

    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []
        self.mode = "cases"
        self.documents: list[dict[str, object]] = []
        self.scope_state = "matched"
        self.as_of = "2026-09-01"

    def reset(self, mode="cases", documents=None, scope_state="matched", as_of="2026-09-01"):
        self.requests = []
        self.mode = mode
        self.documents = documents or []
        self.scope_state = scope_state
        self.as_of = as_of

    @property
    def keyword_requests(self) -> list[dict[str, object]]:
        return [request for request in self.requests if "q" in request["params"]]

    def handle(self, route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path != "/search":
            route.fulfill(status=503, content_type="application/json", body='{"ok":false}')
            return
        params = parse_qs(parsed.query)
        self.requests.append({"url": route.request.url, "params": params})
        if self.mode == "provider_failure":
            route.fulfill(
                status=503,
                content_type="application/json",
                headers={"Access-Control-Allow-Origin": "*"},
                body='{"ok":false,"reason":"provider-unavailable"}',
            )
            return
        if self.mode == "cases":
            query = params.get("q", [""])[0]
            case = CASES.get(query)
            documents = [search_document(case)] if case else []
        else:
            documents = self.documents
        route.fulfill(
            status=200,
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
            body=json.dumps(scoped_response(
                documents,
                scope_state=self.scope_state,
                as_of=self.as_of,
            )),
        )


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


def rendered_pins(page) -> list[str]:
    return [
        text.replace("PIN ", "").strip()
        for text in page.locator("#list .money-row-card .pin").all_inner_texts()
        if text.startswith("PIN ")
    ]


def scope_receipt(page) -> dict[str, str] | None:
    receipt = page.locator("[data-contracts-scope-receipt]").first
    if not receipt.count():
        return None
    attributes = (
        "outcome", "match-mode", "capability", "lenses", "coverage-state",
        "coverage-reported", "query", "candidates", "bound", "fallback",
    )
    return {
        name: receipt.get_attribute(f"data-scope-{name}")
        for name in attributes
    } | {"text": receipt.inner_text()}


def open_contracts(context, fixture, route, *, wait_for_rows=True, wait_for_receipt=False):
    page = context.new_page()
    page.goto(f"{BASE}{route}", wait_until="domcontentloaded", timeout=30_000)
    if wait_for_rows:
        page.locator("#list .money-row-card").first.wait_for(state="visible", timeout=30_000)
    else:
        page.wait_for_function(
            "() => document.querySelector('#list')?.textContent?.trim()",
            timeout=30_000,
        )
    if wait_for_receipt:
        # The receipt lands when the scoped retrieval resolves, which is after the
        # static-first paint. It is emitted even with no resident copy to show, so
        # wait for it attached rather than visible.
        page.locator("[data-contracts-scope-receipt]").first.wait_for(
            state="attached", timeout=30_000,
        )
    return page


def check_beyond_snapshot_awards(context, fixture) -> None:
    """The original regression: three PINs the bounded snapshot alone loses."""
    for query, case in CASES.items():
        fixture.reset(mode="cases")
        page = open_contracts(context, fixture, f"/browse/contracts/?mode=award&q={query}")
        body = page.locator("#list").inner_text()
        assert str(case["title"]) in body, (query, body)
        assert f"PIN {case['pin']}" in body, (query, body)
        assert "Nothing found" not in body, (query, body)

        # A1: the request Browse issued is the registered Contracts scope, and the
        # query it sent is the query the resident typed — not a local rewrite.
        assert fixture.keyword_requests, query
        params = fixture.keyword_requests[0]["params"]
        assert params["q"] == [query], params
        assert params.get("scope") == list(SCOPE_LENSES), params
        page.close()
    print("OK 31.1 beyond-snapshot award PINs render through the scoped Contracts request")


def check_queryless_route(context, fixture) -> None:
    """A queryless Contracts route stays static-first and asks the capability nothing."""
    fixture.reset(mode="cases")
    # Whether the retained snapshot currently holds an open solicitation depends on
    # its vintage, so the assertion is about who was asked, not about a row count:
    # a queryless route paints from the local snapshot and calls no capability.
    page = open_contracts(context, fixture, "/browse/contracts/", wait_for_rows=False)
    assert not fixture.keyword_requests, fixture.keyword_requests
    assert scope_receipt(page) is None, "a route that asked nothing must claim no coverage"
    page.close()
    print("OK 31.2 queryless Contracts route renders from the local snapshot with no scoped call")


def check_keyword_parity(context, fixture) -> None:
    """A2/A3: same query, same canonical references, same rank order, same receipt."""
    documents = [search_document(CASES[case]) for case in RANKED_CASES]
    fixture.reset(mode="documents", documents=documents, as_of="2026-09-01")
    page = open_contracts(
        context, fixture, f"/browse/contracts/?mode=award&q={RANKED_QUERY}", wait_for_receipt=True,
    )

    pins = rendered_pins(page)
    capability_pins = [
        document["object_ref"].removeprefix("procurement:")
        for document in documents
    ]
    # Canonical references and rank order: the Browse rows are the capability's
    # documents, in the capability's order, not a locally re-sorted set.
    assert [pin for pin in pins if pin in capability_pins] == capability_pins, (pins, capability_pins)
    assert len(pins) <= RESULT_BOUND, pins

    receipt = scope_receipt(page)
    assert receipt is not None, "a scoped retrieval must render its coverage receipt"
    assert receipt["outcome"] == "matched", receipt
    assert receipt["match-mode"] == "scoped_keyword", receipt
    assert receipt["capability"] == CAPABILITY_REFERENCE, receipt
    assert receipt["lenses"] == ",".join(SCOPE_LENSES), receipt
    assert receipt["coverage-state"] == "matched", receipt
    assert receipt["coverage-reported"] == "1", receipt
    assert receipt["query"] == RANKED_QUERY, receipt
    assert receipt["candidates"] == str(len(documents)), receipt
    assert receipt["bound"] == str(RESULT_BOUND), receipt
    # Freshness is the capability's clock, rendered, not a Browse-local guess.
    assert "2026-09-01" in receipt["text"], receipt

    request = fixture.keyword_requests[0]["params"]
    assert request["q"] == [RANKED_QUERY], request
    assert request["scope"] == list(SCOPE_LENSES), request
    page.close()
    print("OK 31.3 Browse and the scoped capability agree on references, order, bounds and freshness")


def check_typed_facets(context, fixture) -> None:
    """A2: typed procurement facets still narrow the shared result set."""
    document = search_document(CASES["mosquito"])
    fixture.reset(mode="documents", documents=[document])
    matching = open_contracts(
        context, fixture,
        "/browse/contracts/?mode=award&q=mosquito&m=Competitive+Sealed+Bid",
    )
    assert "02EA43001R0X00" in rendered_pins(matching), matching.locator("#list").inner_text()
    matching.close()

    fixture.reset(mode="documents", documents=[document])
    narrowed = open_contracts(
        context, fixture,
        "/browse/contracts/?mode=award&q=mosquito&m=Emergency+Procurement",
        wait_for_rows=False,
    )
    assert "02EA43001R0X00" not in rendered_pins(narrowed), narrowed.locator("#list").inner_text()
    narrowed.close()
    print("OK 31.4 typed procurement facets narrow the scoped result set without bypassing it")


def check_exact_object_reference(context, fixture) -> None:
    """A2: an exact object reference stays an exact lookup, not a keyword federation."""
    case = CASES["05626S0012"]
    facet = json.dumps({
        "contract_identity": {
            "object_ref": f"procurement:{case['pin']}",
            "source_observation_ref": f"notice:{case['request_id']}",
        },
    })
    fixture.reset(mode="documents", documents=[search_document(case)])
    page = open_contracts(
        context, fixture,
        f"/browse/contracts/?mode=award&facet={quote(facet)}",
        wait_for_receipt=True,
    )
    assert str(case["pin"]) in rendered_pins(page), page.locator("#list").inner_text()
    exact = [
        request for request in fixture.requests
        if "object_ref" in request["params"]
    ]
    assert exact, fixture.requests
    assert exact[0]["params"]["object_ref"] == [f"procurement:{case['pin']}"], exact[0]
    assert exact[0]["params"]["source_ref"] == [f"notice:{case['request_id']}"], exact[0]
    # An exact object lookup resolves one canonical object; it requests no lens scope.
    assert "scope" not in exact[0]["params"], exact[0]
    receipt = scope_receipt(page)
    assert receipt is not None and receipt["match-mode"] == "exact_object_ref", receipt
    page.close()
    print("OK 31.5 an exact object reference is preserved as an exact lookup")


def check_provider_failure(context, fixture) -> None:
    """A3: a provider failure is disclosed, and the snapshot fallback is named."""
    fixture.reset(mode="provider_failure")
    page = open_contracts(
        context, fixture,
        f"/browse/contracts/?mode=award&q={RANKED_QUERY}",
        wait_for_rows=False, wait_for_receipt=True,
    )
    receipt = scope_receipt(page)
    assert receipt is not None, "a failed capability must not render as an ordinary result set"
    assert receipt["outcome"] == "unavailable", receipt
    assert receipt["fallback"] == "local_snapshot", receipt
    assert "could not be reached" in receipt["text"], receipt
    body = page.locator("#list").inner_text()
    if not rendered_pins(page):
        # With nothing else to show, the failure replaces the empty state outright.
        assert "Nothing found" not in body, body
    page.close()
    print("OK 31.6 a provider failure is disclosed and never presented as an empty contract set")


def check_empty_result(context, fixture) -> None:
    """A3: a genuinely empty capability result stays distinguishable from a failure."""
    fixture.reset(mode="documents", documents=[], scope_state="empty")
    page = open_contracts(
        context, fixture,
        "/browse/contracts/?mode=award&q=zzzznotacontract",
        wait_for_rows=False, wait_for_receipt=True,
    )
    receipt = scope_receipt(page)
    body = page.locator("#list").inner_text()
    if receipt is not None:
        assert receipt["outcome"] == "empty", receipt
        assert receipt["fallback"] in ("", None), receipt
        assert "could not be reached" not in receipt["text"], receipt
    assert "could not be reached" not in body, body
    page.close()
    print("OK 31.7 an empty scoped result is not reported as an unavailable source")


def check_static_first_enrichment(context, fixture) -> None:
    """A2: a non-award mode paints the snapshot first and folds the scope in after."""
    solicitation = {
        "pin": "05626S0099",
        "request_id": "20260807099",
        "title": "Rooftop solar installation solicitation",
        "source_family": "city_record_notice",
        "browse_record": {
            "request_id": "20260807099",
            "start_date": "2026-08-07",
            "agency_name": "Citywide Administrative Services",
            "type_of_notice_description": "Solicitation",
            "short_title": "Rooftop solar installation solicitation",
            "pin": "05626S0099",
            "procurement_stages": ["solicitation"],
            "primary_stage": "solicitation",
            "source_system": "city_record_notice",
        },
    }
    document = search_document(solicitation) | {"process_role": "solicitation"}
    fixture.reset(mode="documents", documents=[document])
    page = context.new_page()
    page.goto(
        f"{BASE}/browse/contracts/?mode=allrfp&q=rooftop",
        wait_until="domcontentloaded", timeout=30_000,
    )
    # The list paints before the capability answers: the retained snapshot is the
    # first thing a reader gets, and the scoped candidate arrives into it.
    page.wait_for_function(
        "() => document.querySelector('#list')?.textContent?.trim()",
        timeout=30_000,
    )
    page.locator("[data-contracts-scope-receipt]").first.wait_for(
        state="attached", timeout=30_000,
    )
    assert str(solicitation["pin"]) in rendered_pins(page), page.locator("#list").inner_text()
    receipt = scope_receipt(page)
    assert receipt is not None and receipt["outcome"] == "matched", receipt
    assert receipt["lenses"] == ",".join(SCOPE_LENSES), receipt
    request = fixture.keyword_requests[0]["params"]
    assert request["q"] == ["rooftop"], request
    assert request["scope"] == list(SCOPE_LENSES), request
    page.close()
    print("OK 31.9 a non-award mode keeps its static-first paint and folds in the scoped candidates")


def check_partial_coverage(context, fixture) -> None:
    """A3: partial or stale scoped coverage is rendered, not collapsed."""
    documents = [search_document(CASES["mosquito"])]
    fixture.reset(mode="documents", documents=documents, scope_state="stale", as_of="2026-06-01")
    page = open_contracts(
        context, fixture, "/browse/contracts/?mode=award&q=mosquito", wait_for_receipt=True,
    )
    receipt = scope_receipt(page)
    assert receipt is not None, "stale scoped coverage must be disclosed"
    assert receipt["outcome"] == "partial", receipt
    assert receipt["coverage-state"] == "stale", receipt
    assert "out of date" in receipt["text"], receipt
    assert "2026-06-01" in receipt["text"], receipt
    assert "02EA43001R0X00" in rendered_pins(page), page.locator("#list").inner_text()
    page.close()
    print("OK 31.8 partial (stale) scoped coverage is rendered beside the rows it qualifies")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        fixture = CapabilityFixture()

        for pattern in (
            "**/api.cityscroll.org/**",
            "**/api.crol-list.org/**",
            "**/cityscroll-worker.crol-worker.workers.dev/**",
        ):
            context.route(pattern, fixture.handle)
        context.route("**/data/procurement_browse_query.json", local_bounded_procurement_query)

        check_beyond_snapshot_awards(context, fixture)
        check_queryless_route(context, fixture)
        check_keyword_parity(context, fixture)
        check_typed_facets(context, fixture)
        check_exact_object_reference(context, fixture)
        check_provider_failure(context, fixture)
        check_empty_result(context, fixture)
        check_partial_coverage(context, fixture)
        check_static_first_enrichment(context, fixture)

        browser.close()

    print("PASS: Contracts Browse and the scoped Contracts capability answer the same question")


if __name__ == "__main__":
    main()
