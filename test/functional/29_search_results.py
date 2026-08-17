"""Search document E2E: typed API records expose inspectable relevance evidence."""

import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
AXE = Path(__file__).parent / "assets" / "axe.min.js"


def assert_axe_green(page, state):
    page.add_script_tag(path=str(AXE))
    violations = page.evaluate("async () => (await axe.run(document)).violations")
    blocking = [row for row in violations if row.get("impact") in {"critical", "serious"}]
    assert not blocking, (state, [(row["id"], row["impact"]) for row in blocking])

def typed_result(term, *, title, object_type, domain, lens, href, state="active"):
    observation_ref = f"fixture:{object_type}:{term}"
    mark_start = title.lower().index(term.lower())
    mark_end = mark_start + len(term)
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
        "provenance": {"producer": "functional_fixture.v1", "lifecycle": {"state": state}},
        "match_fields": [{
            "field": "title",
            "matched_term": term,
            "source_observation_ref": observation_ref,
        }],
        "match_evidence": {
            "field": "title",
            "token_offsets": [0, 1],
            "character_offsets": [mark_start, mark_end],
            "matched_normalized_term": term,
            "source_identifier": observation_ref,
            "snippet": {
                "text": title,
                "mark_start": mark_start,
                "mark_end": mark_end,
            },
        },
        "ranking": {"lifecycle_state": state},
        "edge_provenance": {
            "document_producer": "functional_fixture.v1",
            "source_observation_refs": [observation_ref],
        },
    }


SEARCH_FIXTURES = {
    "police": [typed_result(
        "police",
        title="NYPD Police Officer Hats",
        object_type="procurement",
        domain="contracts",
        lens="notices",
        href="/browse/contracts/?mode=award&q=fixture-police",
    )],
    "zoning": [typed_result(
        "zoning",
        title="Subcommittee on Zoning and Franchises meeting",
        object_type="meeting",
        domain="meetings",
        lens="notices",
        href="/meetings/meeting%3Acity_record%3Afixture-zoning",
    )],
    "budget": [typed_result(
        "budget",
        title="Agency budget systems contract",
        object_type="procurement",
        domain="contracts",
        lens="notices",
        href="/browse/contracts/?mode=award&q=fixture-budget",
        state="archived",
    )],
    "contract": [typed_result(
        "contract",
        title="Current contract award",
        object_type="procurement",
        domain="contracts",
        lens="notices",
        href="/browse/contracts/?mode=award&q=fixture-contract",
    )],
    "hearing": [typed_result(
        "hearing",
        title="Public hearing and meeting notice",
        object_type="meeting",
        domain="meetings",
        lens="notices",
        href="/meetings/meeting%3Acity_record%3Afixture-hearing",
    )],
}

FAMILIES = ["contracts", "people-organizations", "land", "rules", "meetings", "exams"]


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


SEARCH_LENSES = [
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels",
]


def search_payload(rows, query, incomplete=False):
    counts = {lens: 0 for lens in SEARCH_LENSES}
    for result in rows:
        counts[result.get("lens", "notices")] += 1
    by_lens = {
        lens: {
            "lens": lens,
            "participated": not (incomplete and lens == "people"),
            "state": "not_indexed" if incomplete and lens == "people" else ("matched" if count else "empty"),
            "reason": "fixture_lens_missing" if incomplete and lens == "people" else None,
            "matched_count": None if incomplete and lens == "people" else count,
            "candidate_count": None if incomplete and lens == "people" else count,
            "invalid_candidate_count": None if incomplete and lens == "people" else 0,
            "indexed_count": None if incomplete and lens == "people" else 1,
            "as_of": None if incomplete and lens == "people" else "2026-08-15T12:00:00Z",
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
        "resolved_term": {
            "canonical_tokens": [query.lower()],
            "structured_filters": {},
            "alias_receipt": None,
        },
        "lanes": [{
            "id": family,
            "status": "matched" if any(result_family(row) == family for row in rows) else "empty",
            "count": sum(result_family(row) == family for row in rows),
            "as_of": "2026-08-16",
            "source": "Bounded public-record fixture",
            "match_mode": "keyword",
            "cards": [row for row in rows if result_family(row) == family],
        } for family in FAMILIES],
        "results": rows,
        "coverage": {
            "schema": "cityscroll.universal_search_coverage.v1",
            "all_lenses_participated": not incomplete,
            "complete_count": None if incomplete else observed,
            "observed_count": observed,
            "total_matches": observed,
            "returned_count": observed,
            "by_entity_type": {},
            "incomplete_lenses": ["people"] if incomplete else [],
            "snapshot": {
                "state": "incomplete" if incomplete else "complete",
                "as_of": None if incomplete else "2026-08-15T12:00:00Z",
                "as_of_by_lens": {lens: row["as_of"] for lens, row in by_lens.items()},
            },
            "by_lens": by_lens,
        },
    }


def json_response(route, body):
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 390, "height": 844})

        def search_api(route):
            query = route.request.url.split("q=", 1)[-1].lower()
            for term, results in SEARCH_FIXTURES.items():
                if term in query:
                    json_response(route, search_payload(results, term))
                    return
            json_response(route, search_payload([], "zzzz-no-match", incomplete=True))

        page.route("https://api.cityscroll.org/search?*", search_api)
        page.route("https://crol-worker.crol-worker.workers.dev/search?*", search_api)

        for index, (term, expected) in enumerate(SEARCH_FIXTURES.items()):
            page.goto(f"{BASE}/search/?q={term}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_function(
                "document.querySelectorAll('[data-search-result]').length > 0",
                timeout=30000,
            )
            results = page.locator("[data-search-result]")
            assert results.count() > 0, term
            text = results.first.text_content() or ""
            assert term.lower() in text.lower(), (term, text)
            assert results.first.locator("a[href^='/']").count() == 1
            assert expected[0]["title"] in text, (term, text)
            assert results.first.locator("mark").count() >= 1
            assert results.first.locator(".topic-search-result-reason").text_content() == "Title match"
            assert results.first.locator(".topic-search-result-type").count() == 1
            assert results.first.locator(".topic-search-result-lens").count() == 1
            expected_state = expected[0]["ranking"]["lifecycle_state"]
            assert results.first.get_attribute("data-lifecycle-state") == expected_state
            assert results.first.locator(".topic-search-result-status").text_content().lower() == expected_state
            coverage = page.locator("[data-search-coverage]")
            assert coverage.get_attribute("data-coverage-state") == "complete"
            assert coverage.locator("strong").first.text_content().startswith("1 match across")
            assert coverage.locator("[data-coverage-lens]").count() == len(SEARCH_LENSES)
            assert page.locator("[data-search-lane]").count() == 6
            lane_actions = page.locator("[data-search-lane-action] a[data-search-handoff-schema]")
            assert lane_actions.count() == 6
            family = result_family(expected[0])
            action = page.locator(f'[data-search-lane="{family}"] [data-search-lane-action] a')
            handoff_url = action.get_attribute("href")
            assert handoff_url and f"q={term}" in handoff_url
            facet = json.loads(parse_qs(urlparse(handoff_url).query)["facet"][0])
            assert facet["search_handoff"]["raw_query"] == term
            assert facet["search_handoff"]["normalized_terms"] == [term]
            assert action.get_attribute("data-source-observation-ref") == expected[0]["source_observation_refs"][0]
            assert page.evaluate(
                "el => el.scrollWidth <= el.clientWidth",
                results.first.element_handle(),
            ), term
            link = results.first.locator("a").first
            link.focus()
            assert link.evaluate("el => getComputedStyle(el).outlineStyle") != "none"
            assert_axe_green(page, f"complete coverage: {term}")

            if term == "zoning":
                page.goto(f"{BASE}{handoff_url}", wait_until="domcontentloaded", timeout=30000)
                page.wait_for_function(
                    "document.body.dataset.appReady === 'true' && document.querySelector('[data-search-handoff-schema]')",
                    timeout=30000,
                )
                arrival = page.locator("[data-search-handoff-schema]").first
                assert "Opened Meetings from topic search" in (arrival.text_content() or "")
                assert arrival.locator("mark").text_content().lower() == "zoning"
                assert arrival.get_attribute("data-source-observation-ref") == expected[0]["source_observation_refs"][0]
                back_href = arrival.locator(".search-handoff-back").get_attribute("href")
                assert back_href and "q=zoning" in back_href and "lane=meetings" in back_href
                assert arrival.locator('[aria-label="Remove topic zoning"]').count() == 1
                assert_axe_green(page, "Meetings handoff arrival")

        page.goto(f"{BASE}/search/?q=zzzz-no-match", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function(
            "document.querySelector('[data-search-lane] .topic-search-lane-status')?.textContent === 'No matches'",
            timeout=30000,
        )
        assert page.locator("[data-search-result]").count() == 0
        assert "No keyword matches in this snapshot" in (page.locator("[data-search-lane]").first.text_content() or "")
        coverage = page.locator("[data-search-coverage]")
        assert coverage.get_attribute("data-coverage-state") == "incomplete"
        assert "Search coverage is incomplete" in (coverage.text_content() or "")
        assert "0 matches across all" not in (coverage.text_content() or "")
        assert_axe_green(page, "incomplete coverage")

        print("PASS: search renders relevant common-term records and an honest empty state")
        browser.close()


if __name__ == "__main__":
    main()
