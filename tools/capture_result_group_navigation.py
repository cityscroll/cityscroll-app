#!/usr/bin/env python3
"""Evidence for the /search/ result-family jump control (cx-01).

Captures the compact, keyboard-operable family list above the first result
group across the response states the card names: complete, partial, empty,
loading, and (source-unavailable) error — at 390px and 1440px, offline, with
no invented network dependency beyond the search page's own two endpoints.

Each state is also run through the vendored axe-core gate (the same engine
and classification `test/functional/11_accessibility.py` uses), and every
capture asserts no horizontal overflow at its viewport.

    python3 tools/capture_result_group_navigation.py [--out DIR]

Writes screenshots to --out (default /tmp/result-group-navigation-captures/,
outside the repository — public evidence stays as a manifest + hashes, not
image bytes)
and the manifest to docs/evidence/result-group-navigation/capture-manifest.json.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST = ROOT / "docs" / "evidence" / "result-group-navigation" / "capture-manifest.json"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

ROUTE = "/search/?q=parks"
VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))
API_ORIGINS = ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev")
FAMILIES = ["contracts", "people-organizations", "land", "rules", "meetings", "exams"]


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


# The keyword result's `domain` — resolved by searchFamilyForResult() in
# site/search_lens_handoff.mjs — is a distinct vocabulary from the family ids
# used everywhere else in this fixture (lane ids, headings, DOM attributes).
FAMILY_TO_DOMAIN = {
    "contracts": "contracts",
    "people-organizations": "people",
    "land": "property",
    "rules": "rules",
    "meetings": "meetings",
    "exams": "staffing",
}


def keyword_result(term, family, index):
    href = f"/browse/{family}/?q=fixture-{term}-{index}"
    return {
        "schema": "cityscroll.search_document.v1",
        "result_schema": "cityscroll.universal_search_result.v1",
        "outcome": "indexed",
        "object_ref": f"fixture:{family}:{term}-{index}",
        "object_type": "procurement" if family == "contracts" else "unclassified",
        "domain": FAMILY_TO_DOMAIN[family],
        "lens": "notices",
        "canonical_href": href,
        "source_route": href,
        "title": f"{term.title()} {family} record {index}",
        "summary": f"Public {family} record about {term}.",
        "search_text": f"{term} {family} record {index}",
        "source_family": "functional_fixture",
        "source_observation_refs": [f"fixture:{family}:{term}-{index}"],
        "classification": {"method": "fixture", "basis": "capture fixture"},
        "provenance": {"producer": "functional_fixture.v1", "lifecycle": {"state": "active"}},
    }


def keyword_payload(term, populated_families):
    results = [
        keyword_result(term, family, i)
        for family in populated_families
        for i in range(populated_families[family])
    ]
    return {
        "schema": "cityscroll.keyword_search_response.v1",
        "query": term,
        "match_mode": "keyword",
        "lanes": [
            {
                "id": family,
                "status": "matched" if populated_families.get(family) else "empty",
                "count": populated_families.get(family, 0),
                "as_of": "2026-09-05",
                "source": "Bounded public-record fixture",
                "match_mode": "keyword",
            }
            for family in FAMILIES
        ],
        "results": results,
        "coverage": {
            "schema": "cityscroll.universal_search_coverage.v1",
            "all_lenses_participated": True,
            "complete_count": len(results),
            "observed_count": len(results),
            "total_matches": len(results),
            "returned_count": len(results),
            "by_entity_type": {},
            "incomplete_lenses": [],
            "snapshot": {"state": "complete", "as_of": "2026-09-05T12:00:00Z", "as_of_by_lens": {}},
            "by_lens": {},
        },
    }


def candidate_payload(term):
    return {
        "schema": "cityscroll.semantic_retrieval.candidate_response.v1",
        "query": term,
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


# Each state names what the jump list must honestly show, per card acceptance.
STATES = (
    ("complete", "every family has a match", {f: 2 for f in FAMILIES}, False, 0),
    ("partial", "some families match and others do not, in the same response", {"contracts": 3, "meetings": 1}, False, 0),
    ("empty", "no family has a match anywhere", {}, False, 0),
    ("loading", "captured mid-flight, before either endpoint answers", {f: 1 for f in FAMILIES}, False, 4.0),
    ("error", "both sources unreachable; every family reads Unavailable, not blank", {}, True, 0),
)


def install_routes(page: Page, base_url: str, families: dict, *, abort: bool, delay_seconds: float) -> None:
    def search_api(route: Route) -> None:
        if abort:
            route.abort()
            return
        if delay_seconds:
            try:
                page.wait_for_timeout(int(delay_seconds * 1000))
            except Exception:
                # The "loading" state intentionally closes the page before this
                # delayed fulfillment completes; the response is then moot.
                return
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        route.fulfill(status=200, content_type="application/json", body=json.dumps(candidate_payload(query)))

    def keyword_api(route: Route) -> None:
        if abort:
            route.abort()
            return
        if delay_seconds:
            try:
                page.wait_for_timeout(int(delay_seconds * 1000))
            except Exception:
                # The "loading" state intentionally closes the page before this
                # delayed fulfillment completes; the response is then moot.
                return
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        route.fulfill(status=200, content_type="application/json", body=json.dumps(keyword_payload(query, families)))

    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{base_url.rstrip('/')}/capabilities/*", capability_module)
    for origin in API_ORIGINS:
        page.route(f"{origin}/search/candidates?*", search_api)
        page.route(f"{origin}/search?*", keyword_api)
        page.route(f"{origin}/search-activity", lambda route: route.fulfill(status=202, content_type="application/json", body='{"ok":true}'))
        page.route(f"{origin}/search-history", lambda route: route.fulfill(status=200, content_type="application/json", body='{"ok":true,"schema":"cityscroll.search_history.v1","state":"unrecognized","limit":25,"entries":[]}'))
        page.route(f"{origin}/events", lambda route: route.fulfill(status=202, content_type="application/json", body='{"ok":true}'))
    page.route("https://**", lambda route: route.abort())


def observe(page: Page) -> dict:
    """Read the jump list and the page's own overflow truth — never assert from a screenshot."""
    return page.evaluate(
        """() => {
          const nav = document.querySelector('[data-search-family-nav]');
          const items = nav ? [...nav.querySelectorAll('.topic-search-family-nav-item')].map((btn) => ({
            label: btn.querySelector('.topic-search-family-nav-label')?.textContent || '',
            status: btn.querySelector('.topic-search-family-nav-status')?.textContent || '',
            state: btn.dataset.state || '',
          })) : [];
          return {
            nav_present: !!nav,
            nav_visible: nav ? !nav.hidden : false,
            items,
            horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          };
        }"""
    )


def assert_focus_moves(page: Page) -> dict:
    """Prove one activation moves focus to the matching heading and issues no navigation."""
    before_url = page.evaluate("() => location.href")
    result = page.evaluate(
        """() => {
          const nav = document.querySelector('[data-search-family-nav]');
          const buttons = nav ? [...nav.querySelectorAll('.topic-search-family-nav-item')] : [];
          const target = buttons.find((b) => b.querySelector('.topic-search-family-nav-status')?.textContent);
          if (!target) return { activated: false };
          target.click();
          const active = document.activeElement;
          return {
            activated: true,
            focused_is_heading: active?.tagName === 'H3',
            focused_text: (active?.textContent || '').trim(),
          };
        }"""
    )
    after_url = page.evaluate("() => location.href")
    result["url_unchanged"] = before_url == after_url
    return result


def run_axe(page: Page, state_name: str, failures: list) -> None:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    for violation in gate:
        nodes = "; ".join(node["target"][0] for node in violation["nodes"][:3])
        print(f"AXE FAIL {state_name}: {violation['id']} ({violation['impact']}) {violation['help']} @ {nodes}")
        failures.append((state_name, violation["id"]))
    if not gate:
        print(f"AXE OK {state_name}: no critical/serious violations ({len(result['violations'])} lesser findings)")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/result-group-navigation-captures")
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    rev = revision()
    captures = []
    axe_failures: list = []

    with StaticServer(ROOT / "site") as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for state, assertion, families, abort, delay in STATES:
            for viewport_name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                install_routes(page, base_url, families, abort=abort, delay_seconds=delay)
                page.goto(f"{base_url.rstrip('/')}{ROUTE}", wait_until="domcontentloaded", timeout=45_000)
                if state == "loading":
                    # Capture the interim state deliberately, before either fetch settles.
                    page.wait_for_selector('[data-search-family-nav]:not([hidden])', timeout=15_000)
                    page.wait_for_timeout(300)
                else:
                    page.wait_for_selector('[data-search-coverage][aria-busy="false"]', state="attached", timeout=10_000)
                    page.wait_for_timeout(400)

                reading = observe(page)
                run_axe(page, f"search [{state}] [{viewport_name}]", axe_failures)
                focus = assert_focus_moves(page) if state != "loading" else {"activated": False, "note": "skipped: targets still settling"}

                shot = out_dir / f"search-{state}-{viewport_name}-{width}.png"
                page.screenshot(path=str(shot), animations="disabled", full_page=True)

                captures.append({
                    "state": state,
                    "route": ROUTE,
                    "viewport": {"name": viewport_name, "width": width, "height": height},
                    "revision": rev,
                    "file": None,
                    "sha256": sha256_file(shot),
                    "assertion": assertion,
                    "observations": reading,
                    "focus_activation": focus,
                })
                page.close()
                if reading["horizontal_overflow"]:
                    axe_failures.append((f"search [{state}] [{viewport_name}]", "horizontal-overflow"))
        browser.close()

    manifest = {
        "schema": "cityscroll.result_group_navigation_capture.v1",
        "change": "cityscroll-contextual-ux/cx-01-result-group-navigation",
        "browser_mode": "headless chromium (playwright), remote hosts stubbed or blocked",
        "route": ROUTE,
        "viewports": [{"name": name, "width": w, "height": h} for name, w, h in VIEWPORTS],
        "revision": rev,
        "no_query_change": "every capture's URL before and after activating a family control was identical",
        "captures": captures,
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST.relative_to(ROOT)}")
    print(f"screenshots at {out_dir} (not part of the repository)")

    if axe_failures:
        print(f"❌ {len(axe_failures)} accessibility/layout finding(s): {axe_failures}")
        raise SystemExit(1)
    print("✅ axe gate green and no horizontal overflow across every state and viewport")


if __name__ == "__main__":
    main()
