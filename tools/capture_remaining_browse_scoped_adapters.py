#!/usr/bin/env python3
"""Capture deterministic static-first/scoped Browse evidence for US-20.

The capability is stubbed at the HTTP boundary. Each pair uses the same route,
query, viewport, build revision, and cache mode; the first frame records the
retained static/local paint and the settled frame records the scoped projection.
No publisher endpoint is contacted by this harness.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "remaining-browse-scoped-adapters"
VIEWPORTS = ((390, 844), (1440, 1000))
SCHEMA = "cityscroll.remaining-browse-scoped-adapter-capture.v1"
ALL_LENSES = (
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
)
CASES = {
    "people": ("/browse/people/?q=parks", ("people", "person:425", "person", "people", "/officials/425/")),
    "property": ("/browse/property/?q=parks", ("parcels", "bbl:1000000001", "parcel", "property", "/parcels/1000000001/")),
    "land": ("/browse/zoning/?q=parks", ("land", "land_use_project:2018X0438", "land_use_project", "zoning", "/browse/zoning/#land/2018X0438")),
    "rules": ("/browse/rules/?q=parks", ("notices", "rulemaking:notice:20260804030", "rulemaking", "rules", "/browse/rules/?q=20260804030")),
    "meetings": ("/browse/meetings/?q=parks", ("meetings", "meeting:fixture-001", "meeting", "meetings", "/meetings/fixture-001/")),
    "exams": ("/browse/exams/?q=caseworker", ("exams", "exam:7016", "civil_service_exam", "staffing", "/exams/7016/")),
}
SCOPE_LENSES = {
    "people": ("people", "agencies", "vendors", "committees", "community_boards"),
    "property": ("parcels",),
    "land": ("land",),
    "rules": ("notices",),
    "meetings": ("meetings", "committees"),
    "exams": ("exams",),
}


def revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
        capture_output=True, text=True,
    ).stdout.strip()


def search_document(case: tuple[str, str, str, str, str]) -> dict[str, object]:
    _lens, object_ref, object_type, domain, href = case
    ref = hashlib.sha256(object_ref.encode()).hexdigest()[:12]
    return {
        "schema": "cityscroll.search_document.v1",
        "object_ref": object_ref,
        "object_type": object_type,
        "domain": domain,
        "canonical_href": href,
        "title": f"US-20 {domain} fixture",
        "summary": f"Scoped {domain} fixture for the parks query.",
        "search_text": f"parks {domain} fixture",
        "source_family": f"{domain}_fixture",
        "source_observation_refs": [f"{domain}:fixture:{ref}"],
        "classification": {"method": "capture_fixture", "basis": "registered Browse scope"},
        "provenance": {"producer": f"{domain}_capture_fixture", "lifecycle": {"state": "current"}},
        "outcome": "indexed",
    }


def response(case: tuple[str, str, str, str, str], lenses: tuple[str, ...]) -> dict[str, object]:
    document = search_document(case)
    coverage = {
        lens: {
            "lens": lens,
            "participated": lens in lenses,
            "state": "matched" if lens in lenses else "out_of_scope",
            "matched_count": 1 if lens in lenses else None,
            "candidate_count": 1 if lens in lenses else None,
            "indexed_count": 1 if lens in lenses else None,
            "as_of": "2026-09-02" if lens in lenses else None,
            "source": "US-20 deterministic capture fixture" if lens in lenses else None,
            "method": "fixture substring index" if lens in lenses else None,
            "reason": None if lens in lenses else "lens_not_in_requested_scope",
        }
        for lens in ALL_LENSES
    }
    requested = {
        "schema": "cityscroll.universal_search_requested_scope.v1",
        "omitted": False,
        "mode": "allowlisted",
        "lenses": list(lenses),
        "by_lens": {lens: {"requested": lens in lenses, "state": coverage[lens]["state"]} for lens in ALL_LENSES},
    }
    return {
        "schema": "cityscroll.universal_search_response.v1",
        "capability_reference": "search.federated@1",
        "results": [document],
        "federated": {
            "schema": "cityscroll.universal_search_federator.v1",
            "query": {"normalized": "parks", "tokens": ["parks"]},
            "ranking_policy": {"id": "cityscroll.cross_lens_rank.v1"},
            "results": [{**document, "result_schema": "cityscroll.universal_search_result.v1", "rank": 1,
                         "match_fields": [{"field": "search_text", "matched_term": "parks",
                                           "source_observation_ref": document["source_observation_refs"][0]}],
                         "edge_provenance": {"matches": []}}],
            "coverage": {"schema": "cityscroll.universal_search_coverage.v1", "by_lens": coverage},
            "requested_scope": requested,
        },
    }


class CapabilityStub:
    def __init__(self) -> None:
        self.requests: list[str] = []

    def handle(self, route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path != "/search":
            route.continue_()
            return
        self.requests.append(route.request.url)
        scopes = tuple(sorted({lens for lens in parse_qs(parsed.query).get("scope", [])}, key=ALL_LENSES.index))
        if not scopes:
            scopes = ("people",)
        case = next((item for item in CASES.values() if item[1][0] in scopes), CASES["people"])[1]
        route.fulfill(status=200, content_type="application/json", body=json.dumps(response(case, scopes)))


def state(page, source: str) -> dict[str, object]:
    selector = {
        "people": "[data-people-organizations-list]",
        "property": "#propertyfeed",
        "land": "#llist",
        "rules": "#rulesfeed",
        "meetings": "#meetingswidening",
        "exams": "#career-results",
    }[source]
    locator = page.locator(selector)
    return {
        "scope_state": locator.get_attribute("data-browse-scope-state"),
        "visible_text_sha256": hashlib.sha256(locator.inner_text().encode()).hexdigest(),
        "visible_text_excerpt": locator.inner_text()[:240],
    }


def capture(page, source: str, route: str, viewport: int, out: Path, stub: CapabilityStub) -> dict[str, object]:
    request_start = len(stub.requests)
    page.goto(route, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_timeout(250)
    before_name = f"{source}-before-{viewport}.png"
    # Capture the complete Browse surface at the requested width. The viewport
    # remains the exact 390px or 1440px contract while the full-page image keeps
    # the source-specific list and its coverage disclosure in the evidence.
    page.screenshot(path=out / before_name, animations="disabled", full_page=True)
    before = state(page, source)
    page.wait_for_timeout(3_000)
    after_name = f"{source}-after-{viewport}.png"
    page.screenshot(path=out / after_name, animations="disabled", full_page=True)
    after = state(page, source)
    return {
        "source": source,
        "route": route,
        "viewport": viewport,
        "mode": "static-first then scoped capability",
        "cache_mode": "stubbed search, retained committed snapshots",
        "before_capture": before_name,
        "after_capture": after_name,
        "before": before,
        "after": after,
        "search_requests": [urlparse(url).query for url in stub.requests[request_start:]],
        "assertion": "static-first paint remains useful; settled keyword candidates carry the registered scope",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-dir", type=Path, default=ROOT / "_site")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if not (args.site_dir / "browse" / "people" / "index.html").exists():
        raise SystemExit("prepared public site missing; run tools/build_public_site.mjs first")
    args.out.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, object]] = []
    stub = CapabilityStub()
    verify_path = ROOT / "test" / "performance" / "verify.py"
    verify_spec = importlib.util.spec_from_file_location("us20_performance_verify", verify_path)
    if verify_spec is None or verify_spec.loader is None:
        raise SystemExit(f"unable to load {verify_path}")
    verify = importlib.util.module_from_spec(verify_spec)
    verify_spec.loader.exec_module(verify)
    StaticServer = verify.StaticServer

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        with StaticServer(args.site_dir) as base_url:
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                context.route("**/api.cityscroll.org/**", stub.handle)
                context.route("**/*workers.dev/**", stub.handle)
                for source, (path, _case) in CASES.items():
                    records.append(capture(context.new_page(), source, f"{base_url.rstrip('/')}{path}", width, args.out, stub))
                context.close()
        browser.close()
    receipt = {
        "schema": SCHEMA,
        "build_revision": revision(),
        "source_revision": revision(),
        "viewports": [width for width, _height in VIEWPORTS],
        "sources": {source: {"lenses": list(SCOPE_LENSES[source])} for source in CASES},
        "records": records,
    }
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"captured {len(records)} static-first/scoped pairs under {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
