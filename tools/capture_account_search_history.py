#!/usr/bin/env python3
"""Before/after evidence for recognized-account search history (sah-04).

The claim is that a search a reader runs while their email link recognizes them
follows the ACCOUNT rather than the browser, and that nothing else changes:

- before/: the tree at HEAD, where the canonical Search page has no continuation
  at all, so a search performed on one device is reachable only from that device.
- after/:  this working tree, where a recognized reader sees a compact list of
  their own recent searches that reopens canonical Search URLs — and where an
  anonymous reader, an empty history, and an unavailable store all render exactly
  the page they render today.

Both trees are captured with the same offline fixtures at the same two viewports,
so the pairs differ only by the change under review.

    python3 tools/capture_account_search_history.py

Writes docs/screenshots/account-search-history/ and the receipt at
docs/evidence/account-search-history.json.
"""

from __future__ import annotations

import functools
import json
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from playwright.sync_api import Page, Route, sync_playwright

from lib.temp_workspace import head_site_workspace

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "account-search-history"
RECEIPT = ROOT / "docs" / "evidence" / "account-search-history.json"

SEARCH_ROUTE = "/search/?q=rats"
CONTINUATION_ROUTE = "/search/"
VIEWPORTS = ((390, 844), (1440, 900))
LIMIT = 25

API_ORIGINS = ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev")
FAMILIES = ["contracts", "people-organizations", "land", "rules", "meetings", "exams"]
SEARCH_LENSES = [
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
]

# Each state is one reader situation the card has to answer for, and the sentence
# is what the before/after pair is supposed to prove about it.
STATES = (
    ("recognized-device-a", SEARCH_ROUTE, "recognized", ["rats"],
     "Device A, recognized: the search just run is remembered under the results, as a link back to the same canonical Search."),
    ("recognized-device-b", CONTINUATION_ROUTE, "recognized", ["rats"],
     "Device B, recognized by the same account: the search from device A is here on first load, with no second sign-in."),
    ("empty", CONTINUATION_ROUTE, "recognized-empty", [],
     "Recognized with nothing remembered yet: one plain sentence and no controls."),
    ("anonymous", SEARCH_ROUTE, "unrecognized", [],
     "Anonymous: ordinary Search and no continuation at all — browser-local behavior is untouched."),
    ("unavailable", SEARCH_ROUTE, "unavailable", [],
     "Personal storage unavailable: Search is unchanged and the continuation stays away rather than showing an error."),
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


# ---- offline fixtures: one search result, and one stubbed personal endpoint ----

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
        "match_fields": [{"field": "title", "matched_term": term, "source_observation_ref": observation_ref}],
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


RATS = typed_result(
    "rats",
    title="Rats abatement services contract",
    object_type="procurement",
    domain="contracts",
    lens="notices",
    href="/browse/contracts/?mode=award&q=fixture-rats",
)


def result_family(row):
    return {"contracts": "contracts", "meetings": "meetings", "rules": "rules"}.get(row.get("domain"))


def keyword_payload(results, query):
    counts = {lens: 0 for lens in SEARCH_LENSES}
    for result in results:
        counts[result.get("lens", "notices")] += 1
    by_lens = {
        lens: {
            "lens": lens, "participated": True,
            "state": "matched" if count else "empty",
            "reason": None, "matched_count": count, "candidate_count": count,
            "invalid_candidate_count": 0, "indexed_count": 1,
            "as_of": "2026-08-15T12:00:00Z", "source": "capture fixture", "method": "fixture_exact_v1",
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
            "as_of": "2026-08-16", "source": "Bounded public-record fixture", "match_mode": "keyword",
            "cards": [row for row in results if result_family(row) == family],
        } for family in FAMILIES],
        "results": results,
        "coverage": {
            "schema": "cityscroll.universal_search_coverage.v1",
            "all_lenses_participated": True,
            "complete_count": observed, "observed_count": observed,
            "total_matches": observed, "returned_count": observed,
            "by_entity_type": {}, "incomplete_lenses": [],
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
        "coverage": {"state": "partial", "boundary": "Bounded capture fixture corpus."},
        "candidates": [],
    }


def canonical_href(query, scope=None):
    params = [("q", query)]
    for key in ("boro", "cd", "council", "neighborhood", "scope"):
        if (scope or {}).get(key):
            params.append((key, scope[key]))
    return "/search/?" + urlencode(params)


def history_body(state, queries):
    if state == "unrecognized":
        return {"ok": True, "schema": "cityscroll.search_history.v1", "state": "unrecognized",
                "limit": LIMIT, "entries": []}
    if state == "unavailable":
        return {"ok": False, "schema": "cityscroll.search_history.v1", "state": "unavailable",
                "limit": LIMIT, "entries": [], "reason": "storage"}
    entries = [{
        "query": query,
        "scope": {},
        "href": canonical_href(query),
        "id": canonical_href(query),
        # A fixed instant, so the same capture rerun produces the same picture.
        "occurred_at": "2026-09-02T12:00:00.000Z",
        "execution_id": None,
    } for query in queries]
    return {"ok": True, "schema": "cityscroll.search_history.v1", "state": "recognized",
            "limit": LIMIT, "entries": entries}


def install_routes(page: Page, base_url: str, state: str, queries) -> None:
    """Keep the capture offline. `capabilities/` is served from the repository root
    rather than from `site/`; every remote origin is stubbed or aborted."""
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    def search_api(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        route.fulfill(status=200, content_type="application/json", body=json.dumps(candidate_payload(query)))

    def keyword_api(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        results = [RATS] if query == "rats" else []
        route.fulfill(status=200, content_type="application/json", body=json.dumps(keyword_payload(results, query)))

    # Playwright inspects a handler's arity, so a bound state must arrive through a
    # closure rather than through default arguments a second parameter would eat.
    def personal_history(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps(history_body(state, queries)))

    def receipt_intake(route: Route) -> None:
        route.fulfill(status=202, content_type="application/json", body='{"ok":true}')

    page.route(f"{base_url.rstrip('/')}/capabilities/*", capability_module)
    for origin in API_ORIGINS:
        page.route(f"{origin}/search/candidates?*", search_api)
        page.route(f"{origin}/search?*", keyword_api)
        page.route(f"{origin}/search-activity", receipt_intake)
        page.route(f"{origin}/search-history", personal_history)
    def open_data(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json", body="[]")

    def blocked(route: Route) -> None:
        route.abort()

    page.route("https://data.cityofnewyork.us/**", open_data)
    page.route("https://**", blocked)


def settle(page: Page, route: str) -> None:
    if "?q=" in route:
        page.wait_for_selector('[data-search-coverage][aria-busy="false"]', timeout=45_000)
    else:
        page.wait_for_selector("[data-search-document]", timeout=45_000)
    page.wait_for_timeout(900)


def observe(page: Page) -> dict:
    """Read what the page actually shows, so a capture cannot claim the wrong state."""
    return page.evaluate(
        """() => {
          const node = document.querySelector('[data-search-history]');
          return {
            url: `${location.pathname}${location.search}`,
            result_titles: [...document.querySelectorAll('[data-search-result] h4')]
              .map((h) => (h.textContent || '').replace(/\\s+/g, ' ').trim()),
            continuation_present: !!node,
            continuation_state: node ? (node.dataset.searchHistoryState || null) : null,
            continuation_visible: node ? !node.hidden : false,
            remembered: node ? [...node.querySelectorAll('.topic-search-history-link')]
              .map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })) : [],
            controls: node ? node.querySelectorAll('button').length : 0,
          };
        }"""
    )


def capture_tree(site: Path, phase: str) -> dict:
    readings: dict = {}
    OUT.mkdir(parents=True, exist_ok=True)
    with StaticServer(site) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for state, route, history_state, queries, _proves in STATES:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                install_routes(page, base_url, history_state, queries)
                page.goto(f"{base_url.rstrip('/')}{route}", wait_until="domcontentloaded", timeout=45_000)
                settle(page, route)
                reading = observe(page)
                shot = OUT / f"{phase}-{state}-{width}.png"
                page.screenshot(path=str(shot), animations="disabled", full_page=True)
                reading["screenshot"] = str(shot.relative_to(ROOT))
                readings[f"{state}@{width}"] = reading
                page.close()
        browser.close()
    return readings


def revision() -> dict:
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True)
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True)
    return {
        "before_commit": head.stdout.strip(),
        "after_tree": "working tree at the commit above plus this change",
        "after_changed_paths": sorted(line[3:] for line in status.stdout.splitlines() if line[3:]),
    }


def main() -> None:
    with head_site_workspace(ROOT, "capture-account-search-history") as site_root:
        before = capture_tree(site_root, "before")
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=ROOT, check=True)
    after = capture_tree(ROOT / "site", "after")

    receipt = {
        "schema": "cityscroll.account-search-history-receipt.v1",
        "change": "cityscroll-engineering/account-search-history",
        "browser_mode": "headless chromium (playwright), remote hosts stubbed or blocked",
        "revision": revision(),
        "routes": {"search": SEARCH_ROUTE, "continuation": CONTINUATION_ROUTE},
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "privacy": (
            "No address, subscriber id, visitor id, network observation, private receipt, or "
            "stored result appears in any frame or reading: the continuation renders only a "
            "query, its place context, a canonical Search URL, and the day it ran."
        ),
        "demonstrates": {state: proves for state, _route, _history, _queries, proves in STATES},
        "before": before,
        "after": after,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {RECEIPT.relative_to(ROOT)}")
    for key, reading in after.items():
        print(f"  after {key}: state={reading['continuation_state']} "
              f"visible={reading['continuation_visible']} remembered={[row['text'] for row in reading['remembered']]}")


if __name__ == "__main__":
    main()
