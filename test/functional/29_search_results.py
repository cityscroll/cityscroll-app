"""Search document E2E: typed API records expose inspectable relevance evidence."""

import json
import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

def typed_result(term, *, title, object_type, domain, lens, href, state="active"):
    observation_ref = f"fixture:{object_type}:{term}"
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
                    json_response(route, {"results": results})
                    return
            json_response(route, {"results": []})

        page.route("https://api.cityscroll.org/search?*", search_api)
        page.route("https://crol-worker.crol-worker.workers.dev/search?*", search_api)

        for term, expected in SEARCH_FIXTURES.items():
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
            assert page.evaluate(
                "el => el.scrollWidth <= el.clientWidth",
                results.first.element_handle(),
            ), term
            link = results.first.locator("a").first
            link.focus()
            assert link.evaluate("el => getComputedStyle(el).outlineStyle") != "none"

        page.goto(f"{BASE}/search/?q=zzzz-no-match", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function(
            "document.querySelector('[data-search-lane] .topic-search-lane-status')?.textContent === 'No matches'",
            timeout=30000,
        )
        assert page.locator("[data-search-result]").count() == 0
        assert "No matching" in (page.locator("[data-search-lane]").first.text_content() or "")

        print("PASS: search renders relevant common-term records and an honest empty state")
        browser.close()


if __name__ == "__main__":
    main()
