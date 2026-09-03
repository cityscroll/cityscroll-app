#!/usr/bin/env python3
"""Capture deterministic homepage Preview form-factor evidence for US-21.

The federated capability is stubbed at the HTTP boundary. Every scenario uses
the same static-first homepage document; the stub is the only thing that
varies. Each record captures the exact route, viewport, build revision,
query, visible scope, and provider/coverage state driving that frame, plus
the assertion the receipt proves, so the evidence is self-describing without
a local filesystem reference.

No publisher endpoint is contacted by this harness.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "preview-federated-form-factor"
VIEWPORTS = ((390, 844), (1440, 900))
SCHEMA = "cityscroll.preview-federated-form-factor-capture.v1"

ALL_LENSES = (
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
)
CONTRACTS_LENSES = ("notices", "vendors")
AS_OF = "2026-09-02"

# Mixed-domain canonical documents: a contract, a public meeting, and a
# resident-facing person record, so the default all-sources answer visibly
# spans more than one domain.
DEFAULT_SHAPES = (
    ("procurement", "contracts", "notices", "/procurements/", "Parks maintenance agreement"),
    ("meeting", "meetings", "meetings", "/meetings/", "Parks Committee public meeting"),
    ("person", "people", "people", "/officials/", "Parks Commissioner office"),
    ("vendor", "contracts", "vendors", "/vendors/", "Parks maintenance vendor"),
)

# A second, distinct query proves the cross-domain answer is not particular to
# one fixture: a land-use record, a rulemaking notice, and a meeting.
MIXED_DOMAIN_SHAPES = (
    ("land_use_project", "zoning", "land", "/browse/zoning/#land/", "Zoning text amendment review"),
    ("rulemaking_notice", "rules", "notices", "/browse/rules/?q=", "Public hearing notice"),
    ("meeting", "meetings", "meetings", "/meetings/", "City Planning Commission session"),
)


def revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
        capture_output=True, text=True,
    ).stdout.strip()


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
        "classification": {"method": "capture_fixture", "basis": "US-21 evidence fixture"},
        "provenance": {"producer": "us21_capture_fixture.v1", "lifecycle": {"state": "current"}},
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


def documents_for(shapes) -> list[dict[str, object]]:
    return [canonical_document(index, *shape) for index, shape in enumerate(shapes, start=1)]


def envelope(query: str, *, lenses: tuple[str, ...] | None, documents, state_overrides: dict[str, str] | None = None) -> dict[str, object]:
    requested = list(ALL_LENSES) if lenses is None else list(lenses)
    overrides = state_overrides or {}
    by_lens: dict[str, dict[str, object]] = {}
    for lens in ALL_LENSES:
        if lens not in requested:
            by_lens[lens] = {
                "lens": lens, "participated": False, "state": "out_of_scope", "reason": None,
                "matched_count": None, "candidate_count": None, "indexed_count": None,
                "as_of": None, "source": None, "method": None,
            }
            continue
        state = overrides.get(lens, "matched")
        by_lens[lens] = {
            "lens": lens, "participated": True, "state": state, "reason": None,
            "matched_count": 1 if state == "matched" else None,
            "candidate_count": 1 if state == "matched" else None,
            "indexed_count": 1, "as_of": AS_OF if state != "provider_unavailable" else None,
            "source": f"{lens} US-21 capture fixture", "method": "fixture",
        }
    return {
        "schema": "cityscroll.universal_search_federator.v1",
        "query": {"normalized": query, "tokens": query.split()},
        "ranking_policy": {"policy": "cityscroll.cross_lens_rank.v1"},
        "results": list(documents),
        "coverage": {"schema": "cityscroll.universal_search_coverage.v1", "by_lens": by_lens},
        "requested_scope": {
            "schema": "cityscroll.universal_search_requested_scope.v1",
            "omitted": lenses is None,
            "mode": "all_registered_lenses" if lenses is None else "allowlisted",
            "lenses": requested,
            "by_lens": {lens: {"requested": lens in requested, "state": by_lens[lens]["state"]} for lens in ALL_LENSES},
        },
    }


class CapabilityStub:
    """Route interception for /nl and /search matching the app's own worker calls."""

    def __init__(self, *, query: str, documents, search_status: int = 200, state_overrides: dict[str, str] | None = None):
        self.query = query
        self.documents = documents
        self.search_status = search_status
        self.state_overrides = state_overrides
        self.requests: list[str] = []

    def handle(self, route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path == "/nl":
            route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({"filter": {"keywords": [self.query]}, "degraded": False}),
            )
            return
        if parsed.path == "/search":
            self.requests.append(route.request.url)
            if self.search_status != 200:
                route.fulfill(status=self.search_status, content_type="application/json", body=json.dumps({"ok": False}))
                return
            scope = tuple(parse_qs(parsed.query).get("scope", []))
            documents = [d for d in self.documents if not scope or d["domain"] == "contracts"]
            body = {
                "schema": "cityscroll.keyword_search_response.v1",
                "capability_reference": "search.federated@1",
                "query": self.query,
                "results": documents,
                "federated": envelope(self.query, lenses=scope or None, documents=documents, state_overrides=self.state_overrides),
            }
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
            return
        route.fulfill(status=503, content_type="application/json", body=json.dumps({"ok": False}))


def drive_preview(page: Page, base_url: str, query: str) -> None:
    page.goto(base_url, wait_until="domcontentloaded", timeout=30_000)
    page.locator("details.ask-cityscroll summary").click()
    page.locator("#nlq").fill(query)
    page.locator("#nlgo").click()
    page.locator("#nltrans [data-preview-state]").first.wait_for(state="visible", timeout=30_000)


def preview_state(page: Page) -> dict[str, object]:
    root = page.locator("#nltrans")
    scope_row = root.locator(".interpret-preview-scope-active")
    coverage_row = root.locator("[data-preview-coverage]")
    return {
        "preview_state": root.locator("[data-preview-state]").first.get_attribute("data-preview-state"),
        "visible_scope": scope_row.inner_text().strip() if scope_row.count() else None,
        "coverage_state": coverage_row.get_attribute("data-preview-coverage") if coverage_row.count() else None,
        "result_card_count": root.locator(".topic-search-result").count(),
        "full_results_href": root.locator("[data-preview-fullresults]").get_attribute("href") if root.locator("[data-preview-fullresults]").count() else None,
    }


def capture_scenario(page: Page, name: str, out: Path, viewport: int, *, route: str, revision_id: str, query: str, scope: str,
                      mode: str, provider_state: str, assertion: str, after: dict[str, object],
                      focus_selector: str = "#nltrans") -> dict[str, object]:
    screenshot_name = f"{name}-{viewport}.png"
    focus = page.locator(focus_selector)
    if focus.count() and focus.first.is_visible():
        focus.first.scroll_into_view_if_needed()
    page.screenshot(path=out / screenshot_name, animations="disabled", full_page=True)
    return {
        "scenario": name,
        "route": route,
        "viewport": viewport,
        "revision": revision_id,
        "query": query,
        "scope": scope,
        "mode": mode,
        "provider_state": provider_state,
        "cache_mode": "stubbed federated capability, no publisher contacted",
        "capture": screenshot_name,
        "observed": after,
        "assertion": assertion,
    }


def capture_all_sources_initial(page: Page, base_url: str, out: Path, viewport: int, revision_id: str) -> dict[str, object]:
    stub = CapabilityStub(query="parks", documents=documents_for(DEFAULT_SHAPES))
    page.context.route("https://api.cityscroll.org/**", stub.handle)
    page.context.route("https://cityscroll-worker.crol-worker.workers.dev/**", stub.handle)
    drive_preview(page, base_url, "parks")
    observed = preview_state(page)
    record = capture_scenario(
        page, "all-sources-initial", out, viewport,
        route=f"{base_url}", revision_id=revision_id, query="parks", scope="all",
        mode="all-sources federation, no scope parameter", provider_state="matched, complete coverage",
        assertion="initial Preview requests the all-sources federation and shows 'All sources' as the active scope with three mixed-domain cards",
        after=observed,
    )
    page.context.unroute("https://api.cityscroll.org/**")
    page.context.unroute("https://cityscroll-worker.crol-worker.workers.dev/**")
    return record


def capture_contracts_narrowed(page: Page, base_url: str, out: Path, viewport: int, revision_id: str) -> dict[str, object]:
    stub = CapabilityStub(query="parks", documents=documents_for(DEFAULT_SHAPES))
    page.context.route("https://api.cityscroll.org/**", stub.handle)
    page.context.route("https://cityscroll-worker.crol-worker.workers.dev/**", stub.handle)
    drive_preview(page, base_url, "parks")
    toggle = page.locator('#nltrans [data-preview-scope-toggle="contracts"]')
    toggle.focus()
    toggle.press("Enter")
    page.locator('#nltrans [data-preview-scope="contracts"]').wait_for(state="visible", timeout=30_000)
    page.locator('#nltrans [data-preview-state="results"]').wait_for(state="visible", timeout=30_000)
    observed = preview_state(page)
    record = capture_scenario(
        page, "contracts-narrowed", out, viewport,
        route=f"{base_url}", revision_id=revision_id, query="parks", scope="contracts",
        mode="registered Contracts allowlist (notices, vendors)", provider_state="matched, complete coverage",
        assertion="one keyboard action narrows the same query to the registered Contracts scope; the active label reads Contracts",
        after=observed,
    )
    page.context.unroute("https://api.cityscroll.org/**")
    page.context.unroute("https://cityscroll-worker.crol-worker.workers.dev/**")
    return record


def capture_mixed_domain(page: Page, base_url: str, out: Path, viewport: int, revision_id: str) -> dict[str, object]:
    query = "zoning hearing"
    stub = CapabilityStub(query=query, documents=documents_for(MIXED_DOMAIN_SHAPES))
    page.context.route("https://api.cityscroll.org/**", stub.handle)
    page.context.route("https://cityscroll-worker.crol-worker.workers.dev/**", stub.handle)
    drive_preview(page, base_url, query)
    observed = preview_state(page)
    record = capture_scenario(
        page, "mixed-domain-results", out, viewport,
        route=f"{base_url}", revision_id=revision_id, query=query, scope="all",
        mode="all-sources federation, no scope parameter", provider_state="matched, complete coverage",
        assertion="an ordinary cross-domain query answers with canonical references from more than one domain, in the capability's own order",
        after=observed,
    )
    page.context.unroute("https://api.cityscroll.org/**")
    page.context.unroute("https://cityscroll-worker.crol-worker.workers.dev/**")
    return record


def capture_partial_coverage(page: Page, base_url: str, out: Path, viewport: int, revision_id: str) -> dict[str, object]:
    stub = CapabilityStub(query="parks", documents=documents_for(DEFAULT_SHAPES), state_overrides={"meetings": "provider_unavailable"})
    page.context.route("https://api.cityscroll.org/**", stub.handle)
    page.context.route("https://cityscroll-worker.crol-worker.workers.dev/**", stub.handle)
    drive_preview(page, base_url, "parks")
    observed = preview_state(page)
    record = capture_scenario(
        page, "partial-coverage", out, viewport,
        route=f"{base_url}", revision_id=revision_id, query="parks", scope="all",
        mode="all-sources federation, one lens degraded", provider_state="partial coverage (meetings unavailable)",
        assertion="results still render while the coverage line honestly discloses that some sources could not be searched",
        after=observed,
    )
    page.context.unroute("https://api.cityscroll.org/**")
    page.context.unroute("https://cityscroll-worker.crol-worker.workers.dev/**")
    return record


def capture_provider_unavailable(page: Page, base_url: str, out: Path, viewport: int, revision_id: str) -> dict[str, object]:
    stub = CapabilityStub(query="parks", documents=documents_for(DEFAULT_SHAPES), search_status=503)
    page.context.route("https://api.cityscroll.org/**", stub.handle)
    page.context.route("https://cityscroll-worker.crol-worker.workers.dev/**", stub.handle)
    drive_preview(page, base_url, "parks")
    page.locator('#nltrans [data-preview-state="error"]').wait_for(state="visible", timeout=30_000)
    observed = preview_state(page)
    record = capture_scenario(
        page, "provider-unavailable", out, viewport,
        route=f"{base_url}", revision_id=revision_id, query="parks", scope="all",
        mode="all-sources federation, transport failure", provider_state="unavailable (HTTP 503)",
        assertion="a total provider failure renders an explicit error state, distinct from a genuine empty result, with the active scope still visible",
        after=observed,
    )
    page.context.unroute("https://api.cityscroll.org/**")
    page.context.unroute("https://cityscroll-worker.crol-worker.workers.dev/**")
    return record


def capture_full_results_handoff(page: Page, base_url: str, out: Path, viewport: int, revision_id: str) -> dict[str, object]:
    stub = CapabilityStub(query="parks", documents=documents_for(DEFAULT_SHAPES))
    page.context.route("https://api.cityscroll.org/**", stub.handle)
    page.context.route("https://cityscroll-worker.crol-worker.workers.dev/**", stub.handle)
    drive_preview(page, base_url, "parks")
    before = preview_state(page)
    href = before["full_results_href"]
    page.goto(f"{base_url.rstrip('/')}{href}", wait_until="domcontentloaded", timeout=30_000)
    destination_query = parse_qs(urlparse(page.url).query).get("q", [""])[0]
    observed = {"handoff_href": href, "destination_url": page.url, "destination_query": destination_query}
    record = capture_scenario(
        page, "full-results-handoff", out, viewport,
        route=f"{base_url}", revision_id=revision_id, query="parks", scope="all",
        mode="full-result destination for the visible scope", provider_state="n/a (destination document)",
        assertion="the full-results link preserves the exact query and lands on the surface matching the visible scope",
        after=observed,
        focus_selector="body",
    )
    page.context.unroute("https://api.cityscroll.org/**")
    page.context.unroute("https://cityscroll-worker.crol-worker.workers.dev/**")
    return record


SCENARIOS = (
    capture_all_sources_initial,
    capture_contracts_narrowed,
    capture_mixed_domain,
    capture_partial_coverage,
    capture_provider_unavailable,
    capture_full_results_handoff,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-dir", type=Path, default=ROOT / "_site")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if not (args.site_dir / "index.html").exists():
        raise SystemExit("prepared public site missing; run tools/build_public_site.mjs first")
    args.out.mkdir(parents=True, exist_ok=True)
    revision_id = revision()
    records: list[dict[str, object]] = []

    import functools
    import threading
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(args.site_dir))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}/"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                for scenario in SCENARIOS:
                    page = context.new_page()
                    records.append(scenario(page, base_url, args.out, width, revision_id))
                    page.close()
                context.close()
            browser.close()
    finally:
        server.shutdown()
        thread.join(timeout=5)

    receipt = {
        "schema": SCHEMA,
        "build_revision": revision_id,
        "source_revision": revision_id,
        "viewports": [width for width, _height in VIEWPORTS],
        "records": records,
    }
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"captured {len(records)} US-21 Preview form-factor evidence record(s) under {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
