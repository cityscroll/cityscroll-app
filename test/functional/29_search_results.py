"""Search E2E: semantic passages and the typed lexical fallback both remain inspectable."""

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
        "provenance": {"producer": "functional_fixture.v1", "lifecycle": {"state": state}},
        "match_fields": [{
            "field": "title",
            "matched_term": term,
            "source_observation_ref": observation_ref,
        }],
        "match_evidence": {
            "field": "title",
            "matched_normalized_term": term,
            "source_identifier": observation_ref,
            "snippet": {
                "text": title,
                "mark_start": match_start,
                "mark_end": match_start + len(term),
            },
        },
        "keyword_evidence": {"status": "matched", "message": None},
        "ranking": {"lifecycle_state": state},
        "edge_provenance": {
            "document_producer": "functional_fixture.v1",
            "source_observation_refs": [observation_ref],
        },
    }


SEMANTIC_FIXTURES = {
    "police": "NYPD Police Officer Hats\nPolice equipment procurement.",
    "zoning": "Subcommittee on Zoning and Franchises meeting\nPublic zoning hearing.",
    "budget": "City budget hearing\nPublic hearing on the agency budget.",
    "contract": "Subscription security contract\nA current contract award.",
    "hearing": "Public hearing\nA public hearing and meeting notice.",
    "late": "Administrative notice\n" + ("Background context. " * 45) + "Late matching evidence.",
    "rat": "Resource Corporation meeting\nThe lexical passage match is incidental.",
    "pest": "Dr. Pestesi spoke at the meeting\nThe lexical passage match is a name.",
    "rodent": "Rodent prevention meeting\nPublic discussion of rodent control.",
}

LEGACY_FALLBACK = typed_result(
    "fallback",
    title="Fallback public contract",
    object_type="procurement",
    domain="contracts",
    lens="notices",
    href="/browse/contracts/?mode=award&q=fixture-fallback",
    state="archived",
)

MEETING_FALLBACK = typed_result(
    "meeting",
    title="Meeting fallback public hearing",
    object_type="meeting",
    domain="meetings",
    lens="notices",
    href="/meetings/meeting%3Acity_record%3Afixture-meeting",
)

TOPICAL_RECALL_RESULTS = {
    term: typed_result(
        term,
        title=title,
        object_type="procurement",
        domain="contracts",
        lens="notices",
        href=f"/browse/contracts/?mode=award&q={term}",
    )
    for term, title in {
        "rat": "Rat control services",
        "pest": "Pest control services",
        "rodent": "Rodent burrow treatment services",
        "mosquito": "Mosquito control products",
    }.items()
}

PROPOSED_CONTRACT = typed_result(
    "software",
    title="Maintenance, support services, software assurance for PhotoManager",
    object_type="procurement",
    domain="contracts",
    lens="notices",
    href="/browse/contracts/?mode=award&q=05626S0013001",
    state="archived",
)
PROPOSED_CONTRACT.update({
    "object_ref": "procurement:05626S0013001",
    "process_role": "award",
    "source_observation_refs": ["notice:20260730029"],
    "provenance": {
        "producer": "city_record_search_document.v1",
        "browse_record": {
            "request_id": "20260730029",
            "start_date": "2026-08-06",
            "agency_name": "Police Department",
            "type_of_notice_description": "Award",
            "short_title": "Maintenance, support services, software assurance for PhotoManager",
            "pin": "05626S0013001",
            "source_system": "city_record",
        },
        "lifecycle": {"state": "archived"},
    },
})
PROPOSED_CONTRACT["match_fields"][0]["source_observation_ref"] = "notice:20260730029"
PROPOSED_CONTRACT["match_evidence"]["source_identifier"] = "notice:20260730029"

POLICE_CONTRACT_SNAPSHOT = {
    "schema_version": 1,
    "delivery_tier": "resident-snapshot",
    "generated_at": "2026-08-15T19:35:39.293Z",
    "count": 1,
    "rows": [{
        "request_id": "20260701043",
        "start_date": "2026-07-08T00:00:00.000",
        "agency_name": "Police Department",
        "type_of_notice_description": "Solicitation",
        "category_description": "Services (other than human services)",
        "short_title": "05626P0001-Paid Detail Application and Software Platform",
        "pin": "05626P0001",
        # Keep the real production-shaped record open as this clock-independent fixture ages.
        "due_date": "2099-08-19T16:00:00.000",
        "selection_method_description": "Competitive Sealed Proposals",
    }],
}


def json_response(route, body):
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


SEARCH_LENSES = [
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
]
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
        "resolved_term": {
            "canonical_tokens": [
                results[0]["match_evidence"]["matched_normalized_term"]
            ] if results else [query],
            "structured_filters": {},
            "alias_receipt": None,
        },
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


def candidate_response(query, passage_text=None):
    candidates = []
    if passage_text:
        sources = [("20260715041", "rules")]
        if query == "police":
            sources.append(("20260723022", "meetings"))
        for native_id, civic_object_family in sources:
            source_id = f"city_record_notice:{native_id}"
            passage_id = f"{source_id}:p0001"
            candidates.append({
            "candidate_id": passage_id,
            "civic_object_family": civic_object_family,
            "source": {
                "id": source_id,
                "family": "city_record_notice",
                "native_id": native_id,
                "title": passage_text.split("\n", 1)[0],
                "url": f"https://a856-cityrecord.nyc.gov/RequestDetail/{native_id}",
                "canonical_href": f"/notices/{native_id}",
            },
            "passage": {
                "id": passage_id,
                "text": passage_text,
                "text_state": "retained",
                "boundary": {"start": 0, "end": len(passage_text)},
            },
            "method": "lexical_fallback_v1",
            "matched_terms": [query],
            "hard_scope_state": "matched",
            "coverage_state": "partial",
            "freshness": {"state": "observed", "observed_on": "2026-08-04"},
            })
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
        "coverage": {"state": "partial", "boundary": "Bounded committed source set."},
        "candidates": candidates,
    }


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.add_init_script("""
            (() => {
              const nativeFetch = window.fetch.bind(window);
              window.fetch = async (...args) => {
                const response = nativeFetch(...args);
                const url = String(args[0]?.url || args[0] || "");
                if (url.includes("q=elevator")) {
                  await new Promise((resolve) => setTimeout(resolve, 1200));
                }
                return response;
              };
            })();
        """)

        def search_api(route):
            query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
            if query == "fallback":
                json_response(route, fallback_payload([LEGACY_FALLBACK], query))
                return
            if query == "meeting-fallback":
                json_response(route, fallback_payload([MEETING_FALLBACK], query))
                return
            for term, passage_text in SEMANTIC_FIXTURES.items():
                if term in query:
                    json_response(route, candidate_response(query, passage_text))
                    return
            json_response(route, candidate_response(query))

        def keyword_search_api(route):
            params = parse_qs(urlparse(route.request.url).query)
            query = params.get("q", [""])[0].lower()
            if params.get("object_ref") == ["procurement:05626S0013001"]:
                assert params.get("source_ref") == ["notice:20260730029"]
                json_response(route, {
                    "schema": "cityscroll.exact_search_response.v1",
                    "match_mode": "exact_object_ref",
                    "results": [PROPOSED_CONTRACT],
                })
                return
            results = (
                [TOPICAL_RECALL_RESULTS[query]] if query in TOPICAL_RECALL_RESULTS
                else [PROPOSED_CONTRACT] if query == "software"
                else []
            )
            json_response(route, fallback_payload(results, query))

        page.route("https://api.cityscroll.org/search/candidates?*", search_api)
        page.route("https://cityscroll-worker.crol-worker.workers.dev/search/candidates?*", search_api)
        page.route("https://api.cityscroll.org/search?*", keyword_search_api)
        page.route("https://cityscroll-worker.crol-worker.workers.dev/search?*", keyword_search_api)
        page.route(
            "**/data/money_resident_snapshot.json",
            lambda route: json_response(route, POLICE_CONTRACT_SNAPSHOT),
        )

        page.goto(f"{BASE}/search/?q=elevator", wait_until="domcontentloaded", timeout=30000)
        loading = page.locator("[data-search-coverage]")
        assert loading.is_visible()
        assert loading.get_attribute("data-coverage-state") == "loading"
        assert loading.get_attribute("aria-busy") == "true"
        assert loading.locator(".loading").count() == 1
        assert loading.locator("strong").text_content() == "Searching…"
        lane = page.locator('[data-semantic-family="contracts"] .topic-search-lane-body')
        assert lane.get_attribute("aria-busy") == "true"
        assert lane.text_content() == "Searching…"
        if screenshot := os.environ.get("CROL_LOADING_SCREENSHOT"):
            page.screenshot(path=screenshot, animations="disabled", full_page=False)
        page.wait_for_function(
            "document.querySelector('[data-search-coverage]')?.dataset.coverageState === 'complete'",
            timeout=30000,
        )
        assert loading.get_attribute("aria-busy") == "false"
        assert loading.locator(".loading").count() == 0
        assert loading.text_content().strip() == "0 matches"
        assert "coverage is incomplete" not in (page.locator("main").text_content() or "").lower()

        for term, passage_text in SEMANTIC_FIXTURES.items():
            page.goto(f"{BASE}/search/?q={term}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_function(
                "document.querySelectorAll('[data-semantic-candidate]').length > 0",
                timeout=30000,
            )
            results = page.locator("[data-semantic-candidate]")
            assert results.count() > 0, term
            text = results.first.text_content() or ""
            assert term.lower() in text.lower(), (term, text)
            assert "Related because" in text
            assert passage_text.split("\n", 1)[0] in text
            primary_link = results.first.locator("h4 a[href='/notices/20260715041']")
            assert primary_link.count() == 1
            marks = results.first.locator(".topic-search-result-passage mark")
            assert marks.count() >= 1
            assert term.lower() in [mark.lower() for mark in marks.all_text_contents()]
            source_link = results.first.locator("a[href^='https://a856-cityrecord.nyc.gov/']")
            assert source_link.count() == 1
            assert source_link.get_attribute("target") == "_blank"
            if term == "police":
                assert page.locator(
                    '[data-semantic-family="rules"] [data-semantic-candidate]'
                ).count() == 1
                assert page.locator(
                    '[data-semantic-family="meetings"] [data-semantic-candidate]'
                ).count() == 1
                assert page.locator('[data-semantic-family="city_record_notice"]').count() == 0

        page.goto(f"{BASE}/search/?q=mosquito", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector('[data-search-lane="contracts"] [data-search-result]')
        mosquito = page.locator('[data-search-lane="contracts"] [data-search-result]').first
        assert "Mosquito control products" in (mosquito.text_content() or "")
        assert mosquito.locator("mark").text_content().lower() == "mosquito"

        for query in ("rat", "pest", "rodent"):
            page.goto(f"{BASE}/search/?q={query}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_selector(f'[data-semantic-family="contracts"] [data-search-result]')
            assert page.locator("[data-semantic-candidate]").count() > 0
            assert page.locator("[data-search-method-value]").count() == 0
            assert "matches" in (page.locator("[data-search-coverage]").text_content() or "")
            keyword = page.locator(
                '[data-semantic-family="contracts"] [data-search-result]'
            ).first
            assert TOPICAL_RECALL_RESULTS[query]["title"] in (keyword.text_content() or "")
            assert keyword.locator("mark").text_content().lower() == query

        page.goto(f"{BASE}/search/?q=software", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector('[data-search-lane="contracts"] [data-search-result]')
        proposed = page.locator('[data-search-lane="contracts"] [data-search-result]').first
        handoff = proposed.locator("[data-search-handoff]")
        handoff_href = handoff.get_attribute("href")
        parsed_handoff = urlparse(handoff_href)
        handoff_params = parse_qs(parsed_handoff.query)
        assert handoff_params["mode"] == ["archive"]
        identity = json.loads(handoff_params["facet"][0])["contract_identity"]
        assert identity == {
            "object_ref": "procurement:05626S0013001",
            "source_observation_ref": "notice:20260730029",
        }
        assert proposed.locator("h4 a").get_attribute("href") == handoff_href
        handoff.click()
        page.locator("#list .money-row-card").first.wait_for(state="visible", timeout=30000)
        contract_list = page.locator("#list").inner_text()
        assert "Maintenance, support services, software assurance for PhotoManager" in contract_list
        assert "PIN 05626S0013001" in contract_list
        assert "Nothing found" not in contract_list

        fallback_cases = [
            ("fallback", LEGACY_FALLBACK, "/browse/contracts/?", "Opened Contracts", "contracts"),
            ("meeting-fallback", MEETING_FALLBACK, "/browse/meetings/?", "Opened Meetings", "meetings"),
        ]
        for query, expected, expected_path, opened_copy, family in fallback_cases:
            page.goto(f"{BASE}/search/?q={query}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_selector("[data-search-result]")
            fallback = page.locator("[data-search-result]").first
            assert fallback.locator("h4 a[href^='/']").count() == 1
            handoff = fallback.locator("[data-search-handoff]")
            assert handoff.count() == 1
            assert expected["title"] in (fallback.text_content() or "")
            assert fallback.locator("mark").count() >= 1
            assert fallback.locator(".topic-search-result-reason").text_content() == "Title match"
            assert fallback.locator(".topic-search-result-type").count() == 1
            assert fallback.locator(".topic-search-result-lens").count() == 1
            expected_state = expected["ranking"]["lifecycle_state"]
            assert fallback.get_attribute("data-lifecycle-state") == expected_state
            assert fallback.locator(".topic-search-result-status").text_content().lower() == expected_state
            assert page.evaluate("el => el.scrollWidth <= el.clientWidth", fallback.element_handle())
            fallback.locator("a").first.focus()
            assert fallback.locator("a").first.evaluate("el => getComputedStyle(el).outlineStyle") != "none"
            coverage = page.locator("[data-search-coverage]")
            assert coverage.get_attribute("data-coverage-state") == "complete"
            assert coverage.locator("strong").first.text_content() == "1 match"
            assert coverage.locator("[data-coverage-lens]").count() == 0
            assert "Bounded public-record fixture" in (
                page.locator(f'[data-search-lane="{family}"] .topic-search-lane-source').text_content() or ""
            )
            assert_axe_green(page, f"keyword fallback coverage: {query}")

            handoff_href = handoff.get_attribute("href")
            assert handoff_href and handoff_href.startswith(expected_path)
            page.goto(f"{BASE}{handoff_href}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_selector("[data-search-handoff-destination]", timeout=30000)
            destination = page.locator("[data-search-handoff-destination]")
            assert opened_copy in (destination.text_content() or "")
            assert destination.locator("[data-search-topic-chip]").count() == 1
            assert destination.locator("mark").text_content().lower() == (
                expected["match_evidence"]["matched_normalized_term"]
            )
            assert destination.get_attribute("data-record-ref") == expected["object_ref"]
            assert destination.locator(".search-handoff-back a").get_attribute("href").startswith(
                f"/search/?q={query}"
            )
            assert_axe_green(page, f"typed handoff: {opened_copy}")

        page.goto(f"{BASE}/browse/contracts/?q=police", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector(".money-row-card [data-match-evidence] mark", timeout=30000)
        contract = page.locator(".money-row-card").first
        assert contract.locator("a[href='/notices/20260701043']").count() == 1
        assert contract.locator("[data-match-evidence] mark").text_content().lower() == "police"
        assert "Police Department" in (contract.locator("[data-match-evidence]").text_content() or "")
        assert_axe_green(page, "Contracts agency-field match evidence")

        page.goto(f"{BASE}/search/?q=police&lang=es", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("[data-semantic-candidate]")
        heading_text = page.locator("#search-heading").text_content() or ""
        assert "Resultados para" in heading_text, heading_text
        assert "Relacionado porque" in (page.locator("[data-semantic-candidate]").first.text_content() or "")

        page.goto(f"{BASE}/search/?q=zzzz-no-match&lang=en", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function(
            "document.querySelector('[data-semantic-family] .topic-search-lane-status')?.textContent === 'No matches'",
            timeout=30000,
        )
        assert page.locator("[data-semantic-candidate]").count() == 0
        assert "bounded source set" in (page.locator("[data-semantic-family]").first.text_content() or "")
        assert page.locator("[data-search-coverage]").text_content().strip() == "0 matches"

        print("PASS: search renders typed passages, relevance-rich fallback, translations, and honest empty states")
        browser.close()


if __name__ == "__main__":
    main()
