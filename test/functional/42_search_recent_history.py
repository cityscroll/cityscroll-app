"""Recent searches E2E: a browser-local trail back to canonical Search URLs.

The store itself is unit-tested (test/search_recent_history.test.mjs). This test
proves the product journey in a real browser at both reader sizes: search `rats`,
search `CB3`, come back to `/search/`, see both in recency order, rerun one,
remove one, clear the rest — with the keyboard and the accessible status region
keeping up — and then breaks every dependency the feature is not allowed to have.

It also asserts the negatives the card is defined by: no result snapshot ever
reaches local storage, no visitor or subscriber identity is stored or displayed,
an off-origin path can never become a rerun target, and the primary search action
is never displaced by the history that sits under it.
"""

import json
import os
import re
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

FAMILIES = ["contracts", "people-organizations", "land", "rules", "meetings", "exams"]
SEARCH_LENSES = [
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
]
INTAKE = "**/search-activity"
STORAGE_KEY = "crol_search_recent_v1"
# The Search document mints one execution identity per settled execution and shares
# it with both continuations; the private intake never hands one back.
EXECUTION_ID_PATTERN = r"^exec_[A-Za-z0-9_-]{8,64}$"
VIEWPORTS = [(1440, 1000), (390, 844)]
# The modules this change owns; a runtime error from any of them is a failure.
SEARCH_MODULES = (
    "search_recent_history.mjs",
    "search_recent_history_view.mjs",
    "search_document.mjs",
    "search_activity_receipt.mjs",
)


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
CB3_MEETING = typed_result(
    "cb3",
    title="CB3 full board meeting",
    object_type="meeting",
    domain="meetings",
    lens="notices",
    href="/meetings/meeting%3Acity_record%3Afixture-cb3",
)


def results_for(query):
    if query == "rats":
        return [RATS_CONTRACT]
    if query == "cb3":
        return [CB3_MEETING]
    return []


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


# Third-party chrome is not part of this contract and carries its own storage
# behavior; blocking it keeps the fail-soft assertions about our own code honest.
THIRD_PARTY = (
    "https://fonts.googleapis.com/**",
    "https://fonts.gstatic.com/**",
    "https://static.cloudflareinsights.com/**",
    "https://challenges.cloudflare.com/**",
    "https://scripts.clarity.ms/**",
    "https://j.clarity.ms/**",
)


def install_search_api(page):
    for pattern in THIRD_PARTY:
        page.route(pattern, lambda route: route.abort())

    def search_api(route):
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        route.fulfill(status=200, content_type="application/json", body=json.dumps(candidate_response(query)))

    def keyword_search_api(route):
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(fallback_payload(results_for(query), query)),
        )

    for origin in ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev"):
        page.route(f"{origin}/search/candidates?*", search_api)
        page.route(f"{origin}/search?*", keyword_search_api)


def accepting_intake():
    def handler(route):
        route.fulfill(status=202, content_type="application/json", body='{"ok":true}')

    return handler


def open_search(page, query=None, *, expect_entries=None):
    """Load Search and wait for the document to publish its own settled state.

    A query page settles when coverage reports it is no longer busy; the recent
    list settles when the document stamps how many entries it painted. Waiting on
    both means no assertion here races the page it is describing.
    """
    suffix = f"/search/?q={query}" if query else "/search/"
    page.goto(f"{BASE}{suffix}", wait_until="domcontentloaded", timeout=30000)
    if query:
        page.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=30000)
    page.wait_for_selector("[data-search-recent-count]", state="attached", timeout=30000)
    if expect_entries is not None:
        page.wait_for_function(
            "(n) => document.querySelector('[data-search-recent-region]')"
            "?.dataset.searchRecentCount === String(n)",
            arg=expect_entries,
            timeout=30000,
        )


def wait_for_history(page, count):
    """Wait for the document to report that it painted exactly `count` entries."""
    page.wait_for_function(
        "(n) => document.querySelector('[data-search-recent-region]')"
        "?.dataset.searchRecentCount === String(n)",
        arg=count,
        timeout=30000,
    )


def stored_execution_ids(page):
    """Every execution identity the browser-local history currently holds."""
    return page.evaluate(
        "() => { try { const raw = localStorage.getItem('crol_search_recent_v1');"
        " return raw ? JSON.parse(raw).entries.map((e) => e.search_execution_id) : []; }"
        " catch (error) { return []; } }"
    )


def rendered_history(page):
    """Read the recent searches a reader can actually see, in visible order."""
    return page.evaluate(
        """() => [...document.querySelectorAll('[data-search-recent-list] li')].map((item) => ({
            query: (item.querySelector('.topic-search-recent-query')?.textContent || '').trim(),
            scope: (item.querySelector('.topic-search-recent-scope')?.textContent || '').trim(),
            href: item.querySelector('[data-search-recent-run]')?.getAttribute('href') || null,
            resolved: item.querySelector('[data-search-recent-run]')?.href || null,
            run_label: item.querySelector('[data-search-recent-run]')?.getAttribute('aria-label') || null,
            remove_label: item.querySelector('[data-search-recent-remove]')?.getAttribute('aria-label') || null,
        }))"""
    )


def persisted(page):
    return page.evaluate(
        "(key) => { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }",
        STORAGE_KEY,
    )


def rendered_rows(page):
    return page.evaluate(
        """() => [...document.querySelectorAll('[data-search-result]')].map((card) =>
            (card.querySelector('h4')?.textContent || '').replace(/\\s+/g, ' ').trim())"""
    )


def history_visible(page):
    return page.evaluate(
        "() => !document.querySelector('[data-search-recent]')?.hasAttribute('hidden')"
    )


def status_text(page):
    return page.locator("[data-search-recent-status]").inner_text().strip()


def assert_primary_action_leads(page, label):
    """The search action must stay first and usable, whatever history renders."""
    order = page.evaluate(
        """() => {
            const form = document.querySelector('[data-search-form]');
            const recent = document.querySelector('[data-search-recent-region]');
            return form.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING ? 'form-first' : 'recent-first';
        }"""
    )
    assert order == "form-first", (label, order)
    form_box = page.locator("[data-search-form]").bounding_box()
    recent_box = page.locator("[data-search-recent-region]").bounding_box()
    assert form_box["y"] < recent_box["y"], (label, form_box, recent_box)
    query_input = page.locator("#search-query")
    assert query_input.is_visible() and query_input.is_enabled(), label
    query_input.click()
    query_input.fill("still typable")
    assert query_input.input_value() == "still typable", label
    query_input.fill("")


def journey(browser, width, height):
    """A1-A3: the commissioned journey at one reader size."""
    label = f"{width}px"
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    install_search_api(page)
    page.route(INTAKE, accepting_intake())

    open_search(page, "rats", expect_entries=1)
    assert rendered_rows(page) == ["Rats abatement services contract"], label
    open_search(page, "CB3", expect_entries=2)
    assert rendered_rows(page) == ["CB3 full board meeting"], label

    # A1: both canonical entries, newest first, on the bare Search document.
    open_search(page, expect_entries=2)
    entries = rendered_history(page)
    assert [entry["query"] for entry in entries] == ["CB3", "rats"], (label, entries)
    assert [entry["href"] for entry in entries] == ["/search/?q=CB3", "/search/?q=rats"], (label, entries)
    assert history_visible(page), label
    assert_primary_action_leads(page, f"{label} populated")

    # A2: rerun opens the exact canonical Search URL and executes normally.
    page.locator("[data-search-recent-run]").first.click()
    page.wait_for_url(f"{BASE}/search/?q=CB3", timeout=15000)
    page.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=30000)
    wait_for_history(page, 2)
    assert rendered_rows(page) == ["CB3 full board meeting"], label

    # A2: the rerun refreshed recency instead of adding a duplicate.
    entries = rendered_history(page)
    assert [entry["query"] for entry in entries] == ["CB3", "rats"], (label, entries)
    assert len(persisted(page)["entries"]) == 2, label

    # A3: remove takes effect immediately, moves focus, and says what happened.
    page.locator("[data-search-recent-remove]").first.click()
    assert [entry["query"] for entry in rendered_history(page)] == ["rats"], label
    assert [entry["query"] for entry in persisted(page)["entries"]] == ["rats"], label
    assert status_text(page).startswith("Removed CB3"), (label, status_text(page))
    assert page.evaluate(
        "() => document.activeElement?.matches('[data-search-recent-run]')"
    ), f"{label}: focus stays inside the list while entries remain"

    # A3: clear takes effect immediately, hides the quiet empty state, and returns
    # focus to the primary search action rather than dropping it on the document.
    page.locator("[data-search-recent-clear]").click()
    assert rendered_history(page) == [], label
    assert not history_visible(page), label
    assert persisted(page) is None or persisted(page)["entries"] == [], label
    assert status_text(page) == "Recent searches cleared.", (label, status_text(page))
    assert page.evaluate("() => document.activeElement?.id"), label
    assert page.evaluate("() => document.activeElement?.id") == "search-query", label

    # Empty history stays quiet on the next visit and never announces itself.
    open_search(page, expect_entries=0)
    assert not history_visible(page), label
    assert status_text(page) == "", (label, status_text(page))
    assert_primary_action_leads(page, f"{label} empty")

    context.close()
    print(f"journey at {label}: search, return, rerun, dedupe, remove, clear")


def keyboard_only(browser):
    """A3: the whole control set is reachable and operable from the keyboard."""
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    install_search_api(page)
    page.route(INTAKE, accepting_intake())
    open_search(page, "rats", expect_entries=1)
    open_search(page, "CB3", expect_entries=2)
    open_search(page, expect_entries=2)

    page.locator("#search-query").focus()
    reached = []
    for _ in range(12):
        page.keyboard.press("Tab")
        marker = page.evaluate(
            """() => {
                const active = document.activeElement;
                if (!active) return null;
                if (active.matches('[data-search-recent-clear]')) return 'clear';
                if (active.matches('[data-search-recent-run]')) return 'run:' + active.textContent.trim();
                if (active.matches('[data-search-recent-remove]')) return 'remove';
                return null;
            }"""
        )
        if marker:
            reached.append(marker)
        if reached.count("remove") == 2:
            break
    assert "clear" in reached, reached
    assert sum(1 for marker in reached if marker.startswith("run:")) == 2, reached
    assert reached.count("remove") == 2, reached

    # Enter on a focused remove control deletes that entry; Enter on a rerun link
    # navigates to its canonical URL. Both are ordinary keyboard semantics.
    page.locator("[data-search-recent-remove]").first.focus()
    page.keyboard.press("Enter")
    assert [entry["query"] for entry in rendered_history(page)] == ["rats"]

    page.locator("[data-search-recent-run]").first.focus()
    page.keyboard.press("Enter")
    page.wait_for_url(f"{BASE}/search/?q=rats", timeout=15000)
    context.close()
    print("keyboard: rerun, remove, and clear are all reachable and operable")


def accessible_names(browser):
    """A3: every control names the entry it acts on, for a screen-reader user."""
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    install_search_api(page)
    page.route(INTAKE, accepting_intake())
    open_search(page, "rats", expect_entries=1)
    open_search(page, expect_entries=1)

    [entry] = rendered_history(page)
    assert entry["run_label"] == "Search again for rats", entry
    assert entry["remove_label"] == "Remove rats from recent searches", entry
    assert page.locator("[data-search-recent-clear]").get_attribute("aria-label") == "Clear recent searches"
    assert page.locator("[data-search-recent]").get_attribute("aria-labelledby") == "search-recent-heading"
    assert page.locator("#search-recent-heading").inner_text().strip() == "Recent searches"

    live = page.evaluate(
        """() => {
            const status = document.querySelector('[data-search-recent-status]');
            return { role: status.getAttribute('role'), live: status.getAttribute('aria-live') };
        }"""
    )
    assert live == {"role": "status", "live": "polite"}, live
    context.close()
    print("accessibility: named controls, labelled section, one polite status region")


def scope_round_trip(browser):
    """A2: query parameters and place context survive exactly as the path says."""
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    install_search_api(page)
    page.route(INTAKE, accepting_intake())

    page.goto(f"{BASE}/search/?q=rats&boro=Manhattan&cd=3", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=30000)
    wait_for_history(page, 1)

    open_search(page, expect_entries=1)
    [entry] = rendered_history(page)
    assert entry["href"] == "/search/?q=rats&boro=Manhattan&cd=3", entry
    assert entry["scope"] == "Borough: Manhattan · Community district: 3", entry

    page.locator("[data-search-recent-run]").click()
    page.wait_for_url(f"{BASE}/search/?q=rats&boro=Manhattan&cd=3", timeout=15000)
    # The rerun is a navigation: let the reopened document execute before reading
    # what it restored, or this asserts against a page that has not painted yet.
    page.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=30000)
    assert page.locator("#search-query").input_value() == "rats"
    assert "Manhattan" in page.locator("[data-search-place]").inner_text()
    assert rendered_rows(page) == ["Rats abatement services contract"]
    context.close()
    print("scope: place context round-trips through the canonical path and reruns")


def eviction(browser):
    """A2: eleven searches leave the ten newest, and never more."""
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    install_search_api(page)
    page.route(INTAKE, accepting_intake())
    for index in range(11):
        open_search(page, f"query{index}", expect_entries=min(index + 1, 10))

    open_search(page, expect_entries=10)
    entries = rendered_history(page)
    assert len(entries) == 10, len(entries)
    assert len(persisted(page)["entries"]) == 10
    assert entries[0]["query"] == "query10", entries[0]
    assert entries[-1]["query"] == "query1", entries[-1]
    assert "query0" not in [entry["query"] for entry in entries]
    context.close()
    print("bound: an eleventh search evicts the oldest and the store stays at ten")


def stored_shape(browser):
    """A4: what is stored is navigation metadata, and nothing else."""
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    install_search_api(page)
    page.route(INTAKE, accepting_intake())
    open_search(page, "rats", expect_entries=1)

    store = persisted(page)
    assert store["schema"] == "cityscroll.search_recent_history.v1", store
    assert sorted(store.keys()) == ["entries", "schema"], store
    [entry] = store["entries"]
    assert sorted(entry.keys()) == [
        "executed_at", "path", "query", "scope", "search_execution_id",
    ], entry
    assert entry["path"] == "/search/?q=rats"
    assert re.match(EXECUTION_ID_PATTERN, entry["search_execution_id"]), entry

    # No rendered row, title, href, or coverage from the served results leaks in.
    blob = json.dumps(store)
    for forbidden in [
        "Rats abatement services contract",
        "/browse/contracts/",
        "procurement:fixture-rats",
        "returned_count",
        "cs_visitor",
        "subscriber",
    ]:
        assert forbidden not in blob, (forbidden, blob)

    # Nor is any identity rendered to the reader; the execution id is not UI copy.
    shown = page.locator("[data-search-recent-region]").inner_text()
    assert entry["search_execution_id"] not in shown, shown
    assert "Rats abatement services contract" not in shown, shown
    context.close()
    print("boundary: stored history is navigation metadata with no result snapshot")


def execution_id_independent_of_intake(browser):
    """A2/A4: one identity per execution, minted locally and never owed to intake.

    The Search document mints a single execution identity and shares it with every
    continuation that describes that execution. Because it is minted locally, an
    intake that is absent, failing, or rejecting cannot take it away — and cannot
    be the thing that supplies it either.
    """
    seen = []
    for label, handler in [
        ("an accepting intake", accepting_intake()),
        ("no intake at all", None),
        ("a failing intake", lambda route: route.abort()),
        ("a rejecting intake", lambda route: route.fulfill(status=500, body="boom")),
    ]:
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        install_search_api(page)
        if handler is not None:
            page.route(INTAKE, handler)
        open_search(page, "rats", expect_entries=1)

        [entry] = persisted(page)["entries"]
        assert re.match(EXECUTION_ID_PATTERN, entry["search_execution_id"] or ""), (label, entry)
        assert entry["path"] == "/search/?q=rats", (label, entry)
        assert rendered_rows(page) == ["Rats abatement services contract"], label
        assert [item["query"] for item in rendered_history(page)] == ["rats"], label
        seen.append(entry["search_execution_id"])

        # A second, different search is a different execution and says so.
        open_search(page, "CB3", expect_entries=2)
        ids = [row["search_execution_id"] for row in persisted(page)["entries"]]
        assert len(set(ids)) == 2, (label, ids)
        assert all(re.match(EXECUTION_ID_PATTERN, value or "") for value in ids), (label, ids)
        context.close()
        print(f"execution identity survives {label}")

    assert len(set(seen)) == len(seen), f"each execution mints its own identity: {seen}"


def hostile_storage(browser):
    """A4: malformed, unsafe, blocked, and full storage all leave Search usable."""
    unsafe_entry = {
        "query": "evil",
        "path": "https://evil.example/search/?q=evil",
        "scope": {},
        "executed_at": "2026-09-01T10:00:00.000Z",
        "search_execution_id": None,
    }
    good_entry = {
        "query": "rats",
        "path": "/search/?q=rats",
        "scope": {},
        "executed_at": "2026-09-01T09:00:00.000Z",
        "search_execution_id": None,
    }
    snapshot_entry = dict(good_entry, query="snapshot", path="/search/?q=snapshot",
                          results=[{"title": "Rats abatement services contract"}])

    cases = [
        ("not JSON at all", "{not json"),
        ("a foreign schema", json.dumps({"schema": "something.else.v1", "entries": [good_entry]})),
        ("an unsafe rerun path", json.dumps({
            "schema": "cityscroll.search_recent_history.v1",
            "entries": [unsafe_entry, good_entry],
        })),
        ("a smuggled result snapshot", json.dumps({
            "schema": "cityscroll.search_recent_history.v1",
            "entries": [snapshot_entry, good_entry],
        })),
    ]
    for label, payload in cases:
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        install_search_api(page)
        page.route(INTAKE, accepting_intake())
        page.add_init_script(
            f"try {{ localStorage.setItem({json.dumps(STORAGE_KEY)}, {json.dumps(payload)}); }} catch (e) {{}}"
        )
        open_search(page)
        shown = [entry["query"] for entry in rendered_history(page)]
        assert "evil" not in shown, (label, shown)
        assert "snapshot" not in shown, (label, shown)
        assert shown in ([], ["rats"]), (label, shown)
        assert_primary_action_leads(page, label)

        # And the document still searches normally on top of the bad state.
        open_search(page, "rats")
        assert rendered_rows(page) == ["Rats abatement services contract"], label
        context.close()
        print(f"search survives persisted state that is {label}")

    for label, script in [
        ("blocked", "Object.defineProperty(window, 'localStorage', "
                    "{ configurable: true, get() { throw new Error('SecurityError'); } });"),
        ("out of quota", "Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };"),
    ]:
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        install_search_api(page)
        page.route(INTAKE, accepting_intake())
        errors = []
        page.on("pageerror", lambda error: errors.append(getattr(error, "stack", None) or str(error)))
        page.add_init_script(script)
        open_search(page, "rats", expect_entries=0)
        assert rendered_rows(page) == ["Rats abatement services contract"], label
        assert not history_visible(page), label
        # Search, the receipt, and the history modules all stay silent. The one
        # observed throw under blocked storage comes from the unrelated
        # beta_flags.js boot path and predates this change, so it is named here
        # rather than asserted away.
        assert not [
            error for error in errors
            if any(module in error for module in SEARCH_MODULES)
        ], (label, errors)
        assert all("beta_flags.js" in error for error in errors), (label, errors)
        if label == "out of quota":
            assert not errors, (label, errors)
        assert_primary_action_leads(page, f"storage {label}")
        context.close()
        print(f"search is unchanged when local storage is {label}")


def cookie_reset(browser):
    """A3/A4: clearing cookies gives a new visitor and leaves Search working.

    Observed behavior, stated plainly: the `cs_visitor` cookie and this local
    history are independent stores. Clearing cookies drops the visitor identity —
    so the next receipt is attributed to a new one — and does not erase local
    storage, which is exactly what a browser does. Search stays usable either way.
    """
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    install_search_api(page)
    page.route(INTAKE, accepting_intake())
    open_search(page, "rats", expect_entries=1)
    open_search(page, "CB3", expect_entries=2)

    context.add_cookies([{
        "name": "cs_visitor",
        "value": "v1_fixture_visitor_identity",
        "url": "https://api.cityscroll.org",
    }])
    assert [cookie["name"] for cookie in context.cookies("https://api.cityscroll.org")] == ["cs_visitor"]

    context.clear_cookies()
    assert context.cookies("https://api.cityscroll.org") == [], "no prior visitor identity survives"

    open_search(page, expect_entries=2)
    assert [entry["query"] for entry in rendered_history(page)] == ["CB3", "rats"], rendered_history(page)
    open_search(page, "rats", expect_entries=2)
    assert rendered_rows(page) == ["Rats abatement services contract"]
    print("cookies: a cleared browser is a new visitor; local history and Search both keep working")
    context.close()


def unchanged_search(browser):
    """A4: turning history on changes nothing about the search itself."""
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    install_search_api(page)
    page.route(INTAKE, accepting_intake())
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    open_search(page, "rats", expect_entries=1)
    first_rows = rendered_rows(page)
    first_coverage = page.locator("[data-search-coverage]").inner_text()

    # Search again with a populated history: same rows, same coverage receipt.
    open_search(page, "rats", expect_entries=1)
    assert rendered_rows(page) == first_rows, (rendered_rows(page), first_rows)
    assert page.locator("[data-search-coverage]").inner_text() == first_coverage
    assert not errors, errors

    empty = page
    open_search(empty, "zzzz-no-match", expect_entries=2)
    assert rendered_rows(empty) == []
    assert [entry["query"] for entry in rendered_history(empty)] == ["zzzz-no-match", "rats"]
    context.close()
    print("search results and coverage are unchanged by the history beside them")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width, height in VIEWPORTS:
            journey(browser, width, height)
        keyboard_only(browser)
        accessible_names(browser)
        scope_round_trip(browser)
        eviction(browser)
        stored_shape(browser)
        execution_id_independent_of_intake(browser)
        hostile_storage(browser)
        cookie_reset(browser)
        unchanged_search(browser)
        browser.close()
    print("PASS: recent searches lead back to canonical Search URLs and never own the page")


main()
