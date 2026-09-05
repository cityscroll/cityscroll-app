"""Search-activity receipt E2E: the receipt describes the page, and never affects it.

The receipt is built from the render plan, not from the DOM. This test closes the
loop from the other side: it reads the rendered cards and asserts the submitted
receipt matches them exactly, then breaks the intake in every way it can break and
asserts the rendered page is byte-for-byte the same.
"""

import json
import os
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

SEARCH_LENSES = [
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
]
FAMILIES = ["contracts", "people-organizations", "land", "rules", "meetings", "exams"]
INTAKE = "**/search-activity"


def typed_result(term, *, title, object_type, domain, lens, href):
    observation_ref = f"fixture:{object_type}:{term}"
    match_start = title.lower().index(term.lower())
    return {
        "schema": "cityscroll.search_document.v1",
        "result_schema": "cityscroll.universal_search_result.v1",
        "outcome": "indexed",
        "object_ref": f"{object_type}:fixture-{term}",
        "object_type": object_type,
        "entity_type": object_type,
        "domain": domain,
        "lens": lens,
        "canonical_href": href,
        "source_route": href,
        "title": title,
        "summary": f"Published {term} record.",
        "search_text": f"{title} Published {term} record.",
        "source_family": "functional_fixture",
        "source_observation_refs": [observation_ref],
        "classification": {"method": "fixture", "basis": "typed browser contract"},
        "provenance": {"producer": "functional_fixture.v1", "lifecycle": {"state": "active"}},
        "match_fields": [{
            "field": "title",
            "matched_term": term,
            "source_observation_ref": observation_ref,
        }],
        "match_evidence": {
            "field": "title",
            "matched_normalized_term": term,
            "source_identifier": observation_ref,
            "snippet": {"text": title, "mark_start": match_start, "mark_end": match_start + len(term)},
        },
        "keyword_evidence": {"status": "matched", "message": None},
        "ranking": {"lifecycle_state": "active"},
        "edge_provenance": {
            "document_producer": "functional_fixture.v1",
            "source_observation_refs": [observation_ref],
        },
    }


RATS_CONTRACT = typed_result(
    "rats",
    title="Rats abatement services contract",
    object_type="procurement",
    domain="contracts",
    lens="notices",
    href="/browse/contracts/?mode=award&q=fixture-rats",
)
RATS_MEETING = typed_result(
    "rats",
    title="Rats and refuse public hearing",
    object_type="meeting",
    domain="meetings",
    lens="notices",
    href="/meetings/meeting%3Acity_record%3Afixture-rats",
)


def result_family(row):
    domain = row.get("domain")
    if domain == "contracts":
        return "contracts"
    if domain in {"people", "places"}:
        return "people-organizations"
    if domain in {"zoning", "property"}:
        return "land"
    if domain in {"rules", "meetings"}:
        return domain
    if domain == "staffing":
        return "exams"
    return None


def fallback_payload(results, query):
    counts = {lens: 0 for lens in SEARCH_LENSES}
    for result in results:
        counts[result.get("lens", "notices")] += 1
    by_lens = {
        lens: {
            "lens": lens,
            "participated": True,
            "state": "matched" if count else "empty",
            "reason": None,
            "matched_count": count,
            "candidate_count": count,
            "invalid_candidate_count": 0,
            "indexed_count": 1,
            "as_of": "2026-08-15T12:00:00Z",
            "source": "functional fixture",
            "method": "fixture_exact_v1",
        }
        for lens, count in counts.items()
    }
    observed = sum(counts.values())
    return {
        "schema": "cityscroll.keyword_search_response.v1",
        "query": query,
        "match_mode": "keyword",
        "resolved_term": {"canonical_tokens": [query], "structured_filters": {}, "alias_receipt": None},
        "lanes": [{
            "id": family,
            "status": "matched" if any(result_family(row) == family for row in results) else "empty",
            "count": sum(result_family(row) == family for row in results),
            "as_of": "2026-08-16",
            "source": "Bounded public-record fixture",
            "match_mode": "keyword",
            "cards": [row for row in results if result_family(row) == family],
        } for family in FAMILIES],
        "results": results,
        "coverage": {
            "schema": "cityscroll.universal_search_coverage.v1",
            "all_lenses_participated": True,
            "complete_count": observed,
            "observed_count": observed,
            "total_matches": observed,
            "returned_count": observed,
            "by_entity_type": {},
            "incomplete_lenses": [],
            "snapshot": {
                "state": "complete",
                "as_of": "2026-08-15T12:00:00Z",
                "as_of_by_lens": {lens: row["as_of"] for lens, row in by_lens.items()},
            },
            "by_lens": by_lens,
        },
    }


def candidate_response(query):
    return {
        "schema": "cityscroll.semantic_retrieval.candidate_response.v1",
        "query": query,
        "method": "lexical_fallback_v1",
        "corpus": {
            "schema": "cityscroll.semantic_retrieval.corpus_manifest.v1",
            "manifest_version": 1,
            "manifest_sha256": "236a61160a3d2fd27c4d6010c4ccae824917b65bea27dddf2f8874293158c50f",
            "content_sha256": "b" * 64,
            "observed_on": "2026-08-04",
        },
        "index": {
            "schema": "cityscroll.semantic_retrieval.source_passage_map.v1",
            "version": "acf9e6484f95ca814320e2ae8e2480dd9cd684e53d4764f8ce31e9530ef2028e",
            "corpus_sha256": "d" * 64,
            "observed_on": "2026-08-04",
        },
        "hard_scope": {"state": "unscoped", "filters": {}},
        "coverage": {"state": "partial", "boundary": "Bounded functional fixture corpus."},
        "candidates": [],
    }


def json_response(route, body):
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def rendered_rows(page):
    """Read what the reader can actually see, in visible order."""
    return page.evaluate(
        """() => [...document.querySelectorAll('[data-search-result]')].map((card) => ({
            title: (card.querySelector('h4')?.textContent || '').replace(/\\s+/g, ' ').trim(),
            entity_type: card.dataset.searchEntityType || null,
        }))"""
    )


def install_search_api(page, results_for):
    def search_api(route):
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        json_response(route, candidate_response(query))

    def keyword_search_api(route):
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        json_response(route, fallback_payload(results_for(query), query))

    for origin in ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev"):
        page.route(f"{origin}/search/candidates?*", search_api)
        page.route(f"{origin}/search?*", keyword_search_api)


def load_search(page, query, extra_params=""):
    page.goto(f"{BASE}/search/?q={query}{extra_params}", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=30000)
    page.wait_for_timeout(500)  # let the settled-state receipt submit


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()

        def results_for(query):
            if query == "rats":
                return [RATS_CONTRACT, RATS_MEETING]
            return []

        # ---- the receipt describes exactly the rendered page ----
        context = browser.new_context()
        page = context.new_page()
        install_search_api(page, results_for)
        receipts = []

        def capture(route):
            receipts.append(json.loads(route.request.post_data))
            route.fulfill(status=202, content_type="application/json", body='{"ok":true}')

        page.route(INTAKE, capture)

        load_search(page, "rats")
        visible = rendered_rows(page)
        assert visible, "the rats fixture must render at least one card"
        assert len(receipts) == 1, f"one settled search submits one receipt, got {len(receipts)}"

        receipt = receipts[0]
        assert receipt["schema"] == "cityscroll.search_execution.v1", receipt["schema"]
        assert receipt["query"]["raw"] == "rats"
        assert receipt["search_path"] == "/search/"
        assert receipt["outcome"] == "matched", receipt["outcome"]
        assert receipt["rendered_count"] == len(visible), (receipt["rendered_count"], len(visible))
        assert [row["rank"] for row in receipt["results"]] == list(range(1, len(visible) + 1))

        # The receipt was built from render inputs; the DOM is the independent check.
        assert [row["title"] for row in receipt["results"]] == [row["title"] for row in visible], (
            receipt["results"], visible,
        )
        assert [row["entity_type"] for row in receipt["results"]] == [
            row["entity_type"] for row in visible
        ]
        assert receipt["family_counts"]["contracts"] == 1, receipt["family_counts"]
        assert receipt["family_counts"]["meetings"] == 1, receipt["family_counts"]
        assert {row["family"] for row in receipt["results"]} == {"contracts", "meetings"}
        assert receipt["results"][0]["canonical_href"].startswith("/browse/contracts/")
        assert receipt["results"][1]["canonical_href"].startswith("/meetings/")
        print("receipt matches rendered rows:", [row["title"] for row in visible])

        # A search with no matches records an empty outcome, not a missing one.
        receipts.clear()
        load_search(page, "zzzz-no-match")
        assert len(receipts) == 1, receipts
        assert receipts[0]["outcome"] == "empty", receipts[0]["outcome"]
        assert receipts[0]["rendered_count"] == 0
        assert receipts[0]["results"] == []
        print("empty search records an empty outcome")

        # A Contracts-only front door (US-22) never reads as "every other family
        # checked out empty" — the receipt now names the scope it actually served.
        receipts.clear()
        load_search(page, "rats", extra_params="&source_scope=contracts")
        visible_scoped = rendered_rows(page)
        assert len(receipts) == 1, f"one settled search submits one receipt, got {len(receipts)}"
        scoped_receipt = receipts[0]
        assert scoped_receipt["front_door_scope"] == "contracts", scoped_receipt["front_door_scope"]
        assert [row["title"] for row in visible_scoped] == ["Rats abatement services contract"], (
            "the Meetings family is out of scope and must not render"
        )
        assert scoped_receipt["family_counts"]["contracts"] == 1, scoped_receipt["family_counts"]
        assert scoped_receipt["family_counts"]["meetings"] == 0, scoped_receipt["family_counts"]
        assert scoped_receipt["incomplete_families"] == [], (
            "a family the front door never asked is unrequested, not incomplete"
        )
        print("Contracts-only search records its front-door scope, not a silent all-families claim")
        context.close()

        # ---- Search is identical when intake fails in every way it can ----
        def render_under(intake_handler):
            local = browser.new_context()
            local_page = local.new_page()
            install_search_api(local_page, results_for)
            if intake_handler is not None:
                local_page.route(INTAKE, intake_handler)
            load_search(local_page, "rats")
            observed = rendered_rows(local_page)
            coverage = local_page.locator("[data-search-coverage]").inner_text()
            errors = local_page.evaluate("() => window.__searchErrors || []")
            local.close()
            return observed, coverage, errors

        accepted, accepted_coverage, _ = render_under(
            lambda route: route.fulfill(status=202, content_type="application/json", body='{"ok":true}')
        )
        for label, handler in [
            ("server error", lambda route: route.fulfill(status=500, body="boom")),
            ("rejected body", lambda route: route.fulfill(
                status=400, content_type="application/json", body='{"ok":false,"reason":"unknown_field"}',
            )),
            ("network failure", lambda route: route.abort()),
            ("no intake at all", None),
        ]:
            observed, coverage, errors = render_under(handler)
            assert observed == accepted, (label, observed, accepted)
            assert coverage == accepted_coverage, (label, coverage, accepted_coverage)
            assert not errors, (label, errors)
            print(f"search unchanged when intake is: {label}")

        browser.close()
    print("PASS: search-activity receipt matches the rendered page and never changes it")


main()
