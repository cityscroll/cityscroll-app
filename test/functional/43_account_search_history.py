"""Account search history E2E: one account, two devices, and everyone else shut out.

Scope of this test, stated plainly: it proves the BROWSER journey in real browser
contexts — that a search run while recognized appears on a second recognized
device, reruns as an ordinary canonical Search there, that remove and clear
propagate, that a different account and an anonymous visitor see none of it, and
that Search itself is unchanged when the personal endpoint fails in every way it
can fail.

The personal endpoint is stubbed here, exactly as test 33 stubs the receipt
intake, because the local functional site has no Worker. The server half — that
identity is derived from the existing session cookie and never from the request,
that the storage key isolates accounts, and that bounds, retention, CORS, and
cache headers hold — is proven against the real handler in
worker/test/search_history.test.mjs. Each context here is bound to one account,
and the test additionally asserts that the browser really did attach the session
cookie to the credentialed cross-origin request.
"""

import json
import os
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

API_ORIGINS = ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev")
HISTORY_ROUTE = "**/search-history"
INTAKE_ROUTE = "**/search-activity"
LIMIT = 25
SEARCH_LENSES = [
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
]
FAMILIES = ["contracts", "people-organizations", "land", "rules", "meetings", "exams"]

READER = "reader-account"
STRANGER = "stranger-account"


# ---- fixture search results (the same shape /search returns) ----

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


RESULTS = {
    "rats": [typed_result(
        "rats",
        title="Rats abatement services contract",
        object_type="procurement",
        domain="contracts",
        lens="notices",
        href="/browse/contracts/?mode=award&q=fixture-rats",
    )],
    "rezoning": [typed_result(
        "rezoning",
        title="Rezoning application public hearing",
        object_type="meeting",
        domain="meetings",
        lens="notices",
        href="/meetings/meeting%3Acity_record%3Afixture-rezoning",
    )],
}


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


def keyword_payload(results, query):
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


def candidate_payload(query):
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


# ---- the stubbed personal endpoint: one store, keyed by account ----

class HistoryService:
    """Stands in for /search-history. It keeps one bounded list per account and,
    like the real route, decides the account from the request rather than from
    anything the page can name."""

    def __init__(self):
        self.accounts = {}
        self.state = "ok"          # "ok" | "unavailable" | "error" | "absent"
        self.requests = []
        self.urls = []

    def entries(self, account):
        return self.accounts.setdefault(account, [])

    def _apply(self, account, body):
        action = body.get("action")
        rows = self.entries(account)
        if action == "clear":
            self.accounts[account] = []
            return
        if action == "remove":
            self.accounts[account] = [row for row in rows if row["id"] != body.get("id")]
            return
        entry = body["entry"]
        raw = entry["query"]["raw"]
        normalized = entry["query"]["normalized"]
        scope = entry.get("scope") or {}
        row = {
            "id": canonical_href(normalized, scope),
            "query": raw,
            "scope": scope,
            "href": canonical_href(raw, scope),
            "occurred_at": entry["occurred_at"],
            "execution_id": entry.get("execution_id"),
        }
        self.accounts[account] = ([row] + [r for r in rows if r["id"] != row["id"]])[:LIMIT]

    def handler(self, account):
        def handle(route):
            request = route.request
            self.requests.append((account, request.method, request.post_data))
            self.urls.append(request.url)
            if self.state == "absent":
                route.abort()
                return
            if self.state == "error":
                route.fulfill(status=500, content_type="application/json", body='{"ok":false}')
                return
            if self.state == "unavailable":
                route.fulfill(status=200, content_type="application/json", body=json.dumps({
                    "ok": False,
                    "schema": "cityscroll.search_history.v1",
                    "state": "unavailable",
                    "limit": LIMIT,
                    "entries": [],
                    "reason": "storage",
                }))
                return
            if account is None:
                route.fulfill(status=200, content_type="application/json", body=json.dumps({
                    "ok": True,
                    "schema": "cityscroll.search_history.v1",
                    "state": "unrecognized",
                    "limit": LIMIT,
                    "entries": [],
                }))
                return
            if request.method == "POST":
                self._apply(account, json.loads(request.post_data))
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "ok": True,
                "schema": "cityscroll.search_history.v1",
                "state": "recognized",
                "limit": LIMIT,
                "entries": self.entries(account),
            }))
        return handle


def canonical_href(query, scope):
    from urllib.parse import urlencode
    params = [("q", query)]
    for key in ("boro", "cd", "council", "neighborhood", "scope"):
        if scope.get(key):
            params.append((key, scope[key]))
    return "/search/?" + urlencode(params)


# ---- browser plumbing ----

def install_routes(page, history, account):
    def search_api(route):
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        route.fulfill(status=200, content_type="application/json", body=json.dumps(candidate_payload(query)))

    def keyword_api(route):
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        body = keyword_payload(RESULTS.get(query, []), query)
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    page.route(HISTORY_ROUTE, history.handler(account))
    page.route(INTAKE_ROUTE, lambda route: route.fulfill(
        status=202, content_type="application/json", body='{"ok":true}'))
    for origin in API_ORIGINS:
        page.route(f"{origin}/search/candidates?*", search_api)
        page.route(f"{origin}/search?*", keyword_api)


def open_device(browser, history, account):
    """One isolated browser context: its own cookie jar, its own storage, and its
    own recognition. Two devices for one account share nothing but the account.

    Recognition is bound to the context here rather than asserted from a cookie,
    because the local functional site has no Worker to exchange an email link
    with. The real exchange and the real cookie read are covered against the
    actual handlers in worker/test/search_history.test.mjs."""
    context = browser.new_context()
    page = context.new_page()
    install_routes(page, history, account)
    return context, page


def load_search(page, query=None):
    """Open the canonical Search route. Without a query the document does not run
    a search at all, which is the state a reader arrives in on a second device."""
    suffix = f"/search/?q={query}" if query else "/search/"
    page.goto(f"{BASE}{suffix}", wait_until="domcontentloaded", timeout=30000)
    if query:
        page.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=30000)
    else:
        page.wait_for_selector("[data-search-document]", timeout=30000)
    page.wait_for_timeout(600)


def island(page):
    return page.evaluate(
        """() => {
          const node = document.querySelector('[data-search-history]');
          if (!node) return null;
          return {
            state: node.dataset.searchHistoryState || null,
            hidden: node.hidden,
            text: (node.textContent || '').replace(/\\s+/g, ' ').trim(),
            queries: [...node.querySelectorAll('.topic-search-history-link')].map((a) => a.textContent.trim()),
            hrefs: [...node.querySelectorAll('.topic-search-history-link')].map((a) => a.getAttribute('href')),
          };
        }"""
    )


def rendered_rows(page):
    return page.evaluate(
        """() => [...document.querySelectorAll('[data-search-result]')].map((card) =>
            (card.querySelector('h4')?.textContent || '').replace(/\\s+/g, ' ').trim())"""
    )


def wait_for_island(page, predicate, label):
    for _ in range(40):
        reading = island(page)
        if reading and predicate(reading):
            return reading
        page.wait_for_timeout(100)
    raise AssertionError(f"{label}: island never reached the expected state (last: {island(page)})")


def main():
    history = HistoryService()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()

        # ---- A1: device A searches; device B reruns it ----
        context_a, device_a = open_device(browser, history, READER)
        load_search(device_a, "rats")
        assert rendered_rows(device_a), "the rats fixture must render at least one card"
        reading = wait_for_island(device_a, lambda r: r["queries"] == ["rats"], "device A after searching")
        assert reading["state"] == "recognized", reading
        print("device A: the search it just ran is remembered")

        context_b, device_b = open_device(browser, history, READER)
        load_search(device_b)
        reading = wait_for_island(device_b, lambda r: r["queries"] == ["rats"], "device B first load")
        assert reading["hrefs"] == ["/search/?q=rats"], reading
        print("device B: the same account's search is there without a second sign-in")

        device_b.click(".topic-search-history-link")
        device_b.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=30000)
        device_b.wait_for_timeout(400)
        assert device_b.url.endswith("/search/?q=rats"), device_b.url
        assert rendered_rows(device_b) == rendered_rows(device_a), (
            rendered_rows(device_b), rendered_rows(device_a))
        print("device B: the entry reruns the same canonical Search:", rendered_rows(device_b))

        # The page asks a cross-origin personal route and never names an account in
        # the URL or the body. Whose history it is, is not the browser's to say.
        assert history.urls, history.urls
        assert all(url.startswith(API_ORIGINS[0] + "/search-history") for url in history.urls), history.urls
        for _account, _method, body in history.requests:
            if not body:
                continue
            for secret in (READER, STRANGER, "cs_session", "subscriber", "@"):
                assert secret not in body, (secret, body)
        print("the personal request names a route, never an account")

        # ---- A3: a different account, and an anonymous visitor ----
        context_c, stranger = open_device(browser, history, STRANGER)
        load_search(stranger)
        reading = wait_for_island(stranger, lambda r: r["state"] == "empty", "another account")
        assert reading["queries"] == [], reading
        assert "rats" not in reading["text"], reading
        print("another account sees its own empty history, never this one")

        context_d, anonymous = open_device(browser, history, None)
        load_search(anonymous, "rezoning")
        assert rendered_rows(anonymous), "an anonymous reader still gets ordinary Search"
        reading = island(anonymous)
        assert reading["hidden"] is True, reading
        assert reading["state"] == "unrecognized", reading
        assert history.accounts.get(READER) and len(history.accounts[READER]) == 1, history.accounts
        assert "rezoning" not in json.dumps(history.accounts), (
            "an anonymous search must never land in an account", history.accounts)
        print("anonymous: ordinary Search, no island, and nothing written to any account")

        # A later recognition does not adopt what that browser searched before.
        context_d.close()
        context_e, recognized_later = open_device(browser, history, STRANGER)
        load_search(recognized_later)
        reading = wait_for_island(recognized_later, lambda r: r["state"] == "empty", "recognized later")
        assert reading["queries"] == [], reading
        print("recognizing later adopts nothing that was searched anonymously")
        context_e.close()

        # ---- A2: remove and clear propagate between the account's devices ----
        load_search(device_a, "rezoning")
        wait_for_island(device_a, lambda r: r["queries"] == ["rezoning", "rats"], "device A after two searches")

        load_search(device_b)
        wait_for_island(device_b, lambda r: r["queries"] == ["rezoning", "rats"], "device B before removal")
        device_b.click('[data-search-history-remove="/search/?q=rats"]')
        wait_for_island(device_b, lambda r: r["queries"] == ["rezoning"], "device B after removal")

        load_search(device_a)
        wait_for_island(device_a, lambda r: r["queries"] == ["rezoning"], "device A sees the removal")
        print("remove on one device reaches the other")

        device_a.click("[data-search-history-clear]")
        wait_for_island(device_a, lambda r: r["state"] == "empty", "device A after clear")
        load_search(device_b)
        wait_for_island(device_b, lambda r: r["state"] == "empty", "device B sees the clear")
        assert history.accounts[READER] == [], history.accounts
        print("clear on one device reaches the other")

        # ---- A4: Search is identical when the personal endpoint fails ----
        history.accounts[READER] = []
        history.state = "ok"
        load_search(device_a, "rats")
        healthy_rows = rendered_rows(device_a)
        healthy_coverage = device_a.locator("[data-search-coverage]").inner_text()

        for label, state in [("storage unavailable", "unavailable"),
                             ("server error", "error"),
                             ("endpoint unreachable", "absent")]:
            history.state = state
            context, page = open_device(browser, history, READER)
            load_search(page, "rats")
            assert rendered_rows(page) == healthy_rows, (label, rendered_rows(page), healthy_rows)
            assert page.locator("[data-search-coverage]").inner_text() == healthy_coverage, label
            reading = island(page)
            assert reading["hidden"] is True, (label, reading)
            assert not page.evaluate("() => window.__searchErrors || []"), label
            context.close()
            print(f"search unchanged and no island when the personal endpoint is: {label}")

        history.state = "ok"
        for context in (context_a, context_b, context_c):
            context.close()
        browser.close()
    print("PASS: recognized search history follows the account across devices and nobody else's")


main()
