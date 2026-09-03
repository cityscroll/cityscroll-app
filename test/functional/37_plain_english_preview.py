"""Drive the homepage's plain-English Preview through the application graph.

The Preview is a compact federated form factor: the initial request is the
all-sources federation (no scope parameter), the active scope is always shown,
one action narrows the same query to the registered Contracts scope, and one
action returns to All sources. Empty input, a genuine zero-result federation,
partial coverage, and provider unavailability stay distinct, and the
full-result handoff preserves the exact query for the visible scope.

Interpretation-failure rendering (the defensive nlTranslate catch) is covered at
the projection level in test/interpret_preview.test.mjs; the interpretation
pipeline itself degrades to device parsing rather than throwing, so it cannot
be driven to failure from the network mock without breaking the app graph.
"""

from __future__ import annotations

import json
import os
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

ALL_LENSES = (
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
)
CONTRACTS_LENSES = ("notices", "vendors")
AS_OF = "2026-09-02"

# Mixed-domain canonical documents: contracts, meetings, and people, so the
# preview visibly answers an ordinary cross-domain topic from every source.
DOCUMENT_SHAPES = (
    ("procurement", "contracts", "notices", "/procurements/", "Parks maintenance agreement"),
    ("meeting", "meetings", "meetings", "/meetings/", "Parks Committee public meeting"),
    ("person", "people", "people", "/officials/", "Parks Commissioner office"),
    ("vendor", "contracts", "vendors", "/vendors/", "Parks maintenance vendor"),
    ("parcel", "property", "parcels", "/parcels/", "Parks parcel registry"),
)


def canonical_document(index: int, object_type: str, domain: str, lens: str, href_root: str, title: str) -> dict[str, object]:
    ref = f"{lens}:preview-{index}"
    return {
        "schema": "cityscroll.search_document.v1",
        "result_schema": "cityscroll.universal_search_result.v1",
        "outcome": "indexed",
        "object_ref": ref,
        "object_type": object_type,
        "entity_type": object_type,
        "domain": domain,
        "lens": lens,
        "canonical_href": f"{href_root}{ref}/",
        "source_route": f"{href_root}{ref}/",
        "title": f"{title} {index}",
        "summary": f"Published {title.lower()} record.",
        "search_text": f"{title} {index}",
        "source_observation_refs": [f"{lens}:fixture-{index}"],
        "classification": {"method": "fixture", "basis": "functional fixture"},
        "provenance": {"producer": "functional_fixture.v1", "lifecycle": {"state": "current"}},
        "stable_key": ref,
        "rank": index,
        "match_fields": [{
            "field": "title",
            "matched_term": title.split()[0].lower(),
            "source_observation_ref": f"{lens}:fixture-{index}",
        }],
        "match_evidence": {
            "field": "title",
            "matched_normalized_term": title.split()[0].lower(),
            "source_identifier": f"{lens}:fixture-{index}",
            "snippet": {"text": f"{title} {index}", "mark_start": 0, "mark_end": len(title.split()[0])},
        },
        "matched_lenses": [lens],
        "ranking": {"policy": "cityscroll.cross_lens_rank.v1"},
    }


def preview_documents(query: str) -> list[dict[str, object]]:
    return [
        canonical_document(index, *shape)
        for index, shape in enumerate(DOCUMENT_SHAPES, start=1)
    ]


def envelope(query: str, *, lenses: tuple[str, ...] | None, documents, state_overrides: dict[str, str] | None = None) -> dict[str, object]:
    """A canonical federator envelope for the requested scope."""
    requested = list(ALL_LENSES) if lenses is None else list(lenses)
    overrides = state_overrides or {}
    by_lens: dict[str, dict[str, object]] = {}
    for lens in ALL_LENSES:
        if lens not in requested:
            by_lens[lens] = {"lens": lens, "participated": False, "state": "out_of_scope", "reason": None,
                             "matched_count": None, "candidate_count": None, "indexed_count": None,
                             "as_of": None, "source": None, "method": None}
            continue
        state = overrides.get(lens, "matched")
        by_lens[lens] = {"lens": lens, "participated": True, "state": state, "reason": None,
                         "matched_count": 1 if state == "matched" else None,
                         "candidate_count": 1 if state == "matched" else None,
                         "indexed_count": 1, "as_of": AS_OF if state != "provider_unavailable" else None,
                         "source": f"{lens} functional fixture source", "method": "fixture"}
    return {
        "schema": "cityscroll.universal_search_federator.v1",
        "query": {"normalized": query, "tokens": query.split()},
        "ranking_policy": {"policy": "cityscroll.cross_lens_rank.v1"},
        "results": list(documents),
        "coverage": {
            "schema": "cityscroll.universal_search_coverage.v1",
            "by_lens": by_lens,
        },
        "requested_scope": {
            "schema": "cityscroll.universal_search_requested_scope.v1",
            "omitted": lenses is None,
            "mode": "all_registered_lenses" if lenses is None else "allowlisted",
            "lenses": requested,
            "by_lens": {lens: {"requested": lens in requested, "state": by_lens[lens]["state"]}
                        for lens in ALL_LENSES},
        },
    }


def json_response(route: Route, body: object, *, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
        body=json.dumps(body),
    )


def install_routes(page: Page, *, search_status: int = 200, state_overrides: dict[str, str] | None = None) -> list[str]:
    """Stub the worker; record every /search request the preview issues."""
    search_requests: list[str] = []

    def worker(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path == "/nl":
            request = json.loads(route.request.post_data or "{}")
            json_response(route, {"filter": {"keywords": [request.get("text", "")]}, "degraded": False})
            return
        if path == "/search":
            search_requests.append(route.request.url)
            if search_status != 200:
                json_response(route, {"ok": False}, status=search_status)
                return
            query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0]
            scope = tuple(parse_qs(urlparse(route.request.url).query).get("scope", []))
            documents = preview_documents(query)
            if scope == CONTRACTS_LENSES:
                documents = [d for d in documents if d["domain"] == "contracts"]
            json_response(route, {
                "schema": "cityscroll.keyword_search_response.v1",
                "capability_reference": "search.federated@1",
                "query": query,
                "results": documents,
                "federated": envelope(query, lenses=scope or None, documents=documents,
                                      state_overrides=state_overrides),
            })
            return
        json_response(route, {"ok": False}, status=503)

    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://cityscroll-worker.crol-worker.workers.dev/**", worker)
    return search_requests


def drive_preview(page: Page, topic: str, trigger: str = "click") -> str:
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("details.ask-cityscroll summary").click()
    page.locator("#nlq").fill(topic)
    if trigger == "click":
        page.locator("#nlgo").click()
    else:
        page.locator("#nlq").press("Enter")
    page.locator("#nltrans [data-preview-state]").wait_for(state="visible", timeout=30_000)
    return page.locator("#nltrans").inner_text()


def scope_query(url: str) -> list[str]:
    return parse_qs(urlparse(url).query).get("scope", [])


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()

    # Empty input is its own state, distinct from every other preview outcome.
    page = context.new_page()
    install_routes(page)
    drive_preview(page, "")
    assert page.locator('#nltrans [data-preview-state="empty"]').count() == 1
    assert "Enter a topic" in page.locator("#nltrans").inner_text()
    page.close()

    for topic, trigger in (("parks", "click"), ("zoning", "enter")):
        page = context.new_page()
        requests = install_routes(page)
        text = drive_preview(page, topic, trigger)

        # A1: the initial request is the all-sources federation — no scope.
        assert requests, (topic, "no federated request issued")
        initial = requests[0]
        assert scope_query(initial) == [], (topic, initial)
        assert parse_qs(urlparse(initial).query).get("q", [""])[0] == topic

        # A2: the active scope is shown with results, the bound is three cards,
        # and coverage/freshness ride along in text, not color alone.
        assert page.locator('#nltrans [data-preview-state="results"]').count() == 1, (topic, text)
        assert page.locator("#nltrans .interpret-preview-scope-active").inner_text().strip().endswith("All sources"), (topic, text)
        assert page.locator("#nltrans .topic-search-result").count() == 3, (topic, text)
        assert page.locator("#nltrans .money-row-card").count() == 0, (topic, text)
        assert "Showing the first 3 matching records" in text, (topic, text)
        assert page.locator('#nltrans [data-preview-coverage="complete"]').count() == 1, (topic, text)
        assert AS_OF in page.locator("#nltrans .interpret-preview-asof").inner_text(), (topic, text)

        # A4: preview cards agree with the capability envelope, in its order.
        titles = page.locator("#nltrans .topic-search-result h4").all_inner_texts()
        assert titles == [f"{shape[4]} {index}" for index, shape in enumerate(DOCUMENT_SHAPES[:3], start=1)], (topic, titles)

        # A4: the full-result handoff preserves the query for the visible scope.
        handoff = page.locator("#nltrans [data-preview-fullresults]")
        assert handoff.get_attribute("href") == f"/search/?q={topic}", (topic, handoff.get_attribute("href"))

        # A3: one keyboard-accessible action narrows the same query to Contracts.
        toggle = page.locator('#nltrans [data-preview-scope-toggle="contracts"]')
        toggle.focus()
        toggle.press("Enter")
        page.locator('#nltrans [data-preview-scope="contracts"]').wait_for(state="visible", timeout=30_000)
        page.locator('#nltrans [data-preview-state="results"]').wait_for(state="visible", timeout=30_000)
        narrowed_requests = [url for url in requests[1:]]
        assert narrowed_requests, (topic, "no narrowed request issued")
        assert scope_query(narrowed_requests[-1]) == ["notices", "vendors"], narrowed_requests[-1]
        assert parse_qs(urlparse(narrowed_requests[-1]).query).get("q", [""])[0] == topic
        text = page.locator("#nltrans").inner_text()
        assert page.locator("#nltrans .interpret-preview-scope-active").inner_text().strip().endswith("Contracts"), text
        assert page.locator("#nltrans .topic-search-result").count() == 2, text  # contracts-domain docs only
        contracts_handoff = page.locator("#nltrans [data-preview-fullresults]")
        assert contracts_handoff.get_attribute("href") == f"/browse/contracts/?q={topic}"

        # A3: one action returns to All sources with the same query.
        back = page.locator('#nltrans [data-preview-scope-toggle="all"]')
        back.click()
        page.locator('#nltrans [data-preview-state="results"]').wait_for(state="visible", timeout=30_000)
        assert scope_query(requests[-1]) == [], requests[-1]
        assert parse_qs(urlparse(requests[-1]).query).get("q", [""])[0] == topic
        assert page.locator("#nltrans .interpret-preview-scope-active").inner_text().strip().endswith("All sources")
        assert page.locator("#nltrans .topic-search-result").count() == 3
        page.close()

    # Partial coverage: results render AND the limitation is disclosed.
    page = context.new_page()
    requests = install_routes(page, state_overrides={"meetings": "provider_unavailable"})
    drive_preview(page, "parks")
    assert page.locator('#nltrans [data-preview-state="results"]').count() == 1
    assert page.locator("#nltrans .topic-search-result").count() == 3
    assert page.locator('#nltrans [data-preview-coverage="partial"]').count() == 1
    assert "coverage is partial" in page.locator("#nltrans").inner_text()
    page.close()

    # Provider unavailable stays an error, never an empty result.
    page = context.new_page()
    requests = install_routes(page, search_status=503)
    text = drive_preview(page, "parks")
    assert page.locator('#nltrans [data-preview-state="error"]').count() == 1, text
    assert "temporarily unavailable" in text, text
    assert page.locator("#nltrans .interpret-preview-scope-active").count() == 1, text
    page.close()

    # A genuine zero-result federation is empty, distinct from failure states.
    page = context.new_page()

    def empty_worker(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path == "/nl":
            json_response(route, {"filter": {"keywords": ["nothingmatches"]}, "degraded": False})
            return
        if path == "/search":
            json_response(route, {
                "schema": "cityscroll.keyword_search_response.v1",
                "query": "nothingmatches",
                "results": [],
                "federated": envelope("nothingmatches", lenses=None, documents=[]),
            })
            return
        json_response(route, {"ok": False}, status=503)

    page.route("https://api.cityscroll.org/**", empty_worker)
    page.route("https://cityscroll-worker.crol-worker.workers.dev/**", empty_worker)
    text = drive_preview(page, "nothingmatches")
    assert page.locator('#nltrans [data-preview-state="empty"]').count() == 1, text
    assert "No matches" in text, text
    assert page.locator("#nltrans .interpret-preview-scope-active").inner_text().strip().endswith("All sources"), text
    assert page.locator("#nltrans [data-preview-fullresults]").get_attribute("href") == "/search/?q=nothingmatches"
    page.close()

    browser.close()

print("PASS: homepage Preview is a scoped federated form factor: all-sources default, one-action Contracts narrowing, honest coverage, and exact-query handoff")
