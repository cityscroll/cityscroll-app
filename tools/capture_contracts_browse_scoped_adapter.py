#!/usr/bin/env python3
"""Capture deterministic evidence for Contracts Browse as a scoped form factor.

Serves the tracked static site and drives `/browse/contracts/` against a stubbed
federated capability at 390px and 1440px, for three states: a keyword query the
capability answers, a provider failure, and a genuinely empty scoped result. The
same query is then taken to the search front door so the handoff between the two
form factors is observable in one evidence set.

The receipt records what the page ASKED as well as what it rendered — the
`/search` requests it issued, whether they carried the registered Contracts
scope, the canonical references rendered, and the coverage receipt the surface
disclosed. Run it once with `--phase before` on the pre-change revision and once
with `--phase after`, and the two receipts state the change without prose.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT / "tools" / "lib"))
from procurement_browse_population import read_browse_population  # noqa: E402

DEFAULT_OUT = ROOT / "docs" / "screenshots" / "contracts-browse-scoped-adapter"
VIEWPORTS = ((390, 844), (1440, 1000))
SCHEMA = "cityscroll.contracts-browse-scoped-adapter-capture.v1"
SCOPE_LENSES = ("notices", "vendors")
ALL_LENSES = (
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
)
LANE_ORDER = (
    "contracts", "people", "agencies", "people-organizations",
    "community_boards", "land", "rules", "meetings", "exams",
)
QUERY = "aircraft"
# A term the retained local snapshot does match, so the failure capture shows the
# disclosed snapshot fallback rather than only the disclosure.
FALLBACK_QUERY = "maintenance"
EMPTY_QUERY = "zzzznotacontract"
AS_OF = "2026-09-01"
DOCUMENTS = (
    {
        "pin": "05626S0012",
        "request_id": "20260807032",
        "title": "Fixed Wing aircraft program management support services.",
    },
    {
        "pin": "05626W0023001",
        "request_id": "20260731016",
        "title": "Fire Alarm Maintenance and Repair for Manhattan and Bronx",
    },
)


def load_performance_helpers():
    path = ROOT / "test" / "performance" / "verify.py"
    spec = importlib.util.spec_from_file_location("performance_verify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def search_document(case: dict[str, str]) -> dict[str, object]:
    pin = case["pin"]
    return {
        "schema": "cityscroll.search_document.v1",
        "object_ref": f"procurement:{pin}",
        "object_type": "procurement",
        "domain": "contracts",
        "canonical_href": f"/browse/contracts/?mode=award&q={pin}",
        "title": case["title"],
        "summary": f"Public contract award {pin}",
        "search_text": f"{case['title']} {pin} contract award",
        "source_family": "city_record_notice",
        "source_observation_refs": [f"notice:{case['request_id']}"],
        "process_role": "award",
        "classification": {
            "method": "exact_procurement_identifier",
            "basis": "stable publisher contract identifier",
        },
        "provenance": {"producer": "city_record_search_document.v1"},
        "outcome": "indexed",
        "coverage_state": "matched",
    }


def scoped_response(documents, *, scope_state="matched") -> dict[str, object]:
    by_lens = {
        lens: (
            {"state": scope_state, "as_of": AS_OF, "indexed_count": None, "reason": None}
            if lens in SCOPE_LENSES
            else {"state": "out_of_scope", "as_of": None, "indexed_count": None}
        )
        for lens in ALL_LENSES
    }
    cards = list(documents)
    lanes = [
        {
            "id": lane,
            "status": ("matched" if cards else "empty") if lane == "contracts" else "empty",
            "count": len(cards) if lane == "contracts" else 0,
            "as_of": AS_OF if lane == "contracts" else None,
            "source": (
                "City Record, PASSPort, Checkbook NYC, and CityScroll vendor profiles"
                if lane == "contracts" else "Bounded read model"
            ),
            "match_mode": "keyword",
            "cards": cards if lane == "contracts" else [],
            "coverage": {"bounded": True, "card_limit": 8, "indexed_count": None, "reason": None},
        }
        for lane in LANE_ORDER
    ]
    return {
        "schema": "cityscroll.universal_search_response.v1",
        "capability_reference": "search.federated@1",
        "query": QUERY,
        "match_mode": "keyword",
        "results": list(documents),
        "lanes": lanes,
        "federated": {
            "schema": "cityscroll.universal_search_federator.v1",
            "coverage": {"schema": "cityscroll.universal_search_coverage.v1", "by_lens": by_lens},
            "requested_scope": {
                "schema": "cityscroll.universal_search_requested_scope.v1",
                "omitted": False,
                "mode": "allowlisted",
                "lenses": list(SCOPE_LENSES),
                "by_lens": {
                    lens: {"requested": lens in SCOPE_LENSES, "state": by_lens[lens]["state"]}
                    for lens in ALL_LENSES
                },
            },
        },
    }


QUERY_FIELDS = (
    "procurement_id", "canonical_href", "procurement_stages", "primary_stage",
    "request_id", "start_date", "due_date", "agency_name", "short_title", "pin",
    "contract_id", "contract_amount", "vendor_name", "selection_method_description",
    "category_description", "type_of_notice_description", "source_system",
    "method_family", "procurement_category", "coverage_state", "additional_description_1",
    "project_id", "project_name",
)


def bounded_query_manifest(route: Route) -> None:
    """Serve the Pages query projection when the checkout lacks its build artifact."""
    response = route.fetch()
    if response.ok:
        route.fulfill(response=response)
        return
    source = ROOT / "site" / "data" / "procurement_browse_rows.json"
    if not source.exists():
        route.fulfill(status=404, content_type="application/json", body="{}")
        return
    browse = read_browse_population(source)
    rows = browse.get("rows", []) if isinstance(browse, dict) else []
    route.fulfill(status=200, content_type="application/json", body=json.dumps({
        "schema": "cityscroll.procurement_browse_query.v1",
        "version": 1,
        "source_model_schema": browse.get("source_model_schema"),
        "generated_at": browse.get("generated_at"),
        "source_model_fingerprint": "contracts-browse-scoped-adapter-capture-v1",
        "query_fields": QUERY_FIELDS,
        "query_rows": [
            {field: row[field] for field in QUERY_FIELDS if field in row}
            for row in rows
        ],
        "row_count": len(rows),
        "shards": [],
        "row_shard_by_id": {},
    }))


class CapabilityStub:
    """A deterministic scoped capability that records what each surface asked."""

    def __init__(self) -> None:
        self.mode = "matched"
        self.requests: list[str] = []

    def handle(self, route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path != "/search":
            route.fulfill(status=503, content_type="application/json", body='{"ok":false}')
            return
        self.requests.append(route.request.url)
        if self.mode == "provider_failure":
            route.fulfill(
                status=503,
                content_type="application/json",
                headers={"Access-Control-Allow-Origin": "*"},
                body='{"ok":false,"reason":"provider-unavailable"}',
            )
            return
        documents = [search_document(case) for case in DOCUMENTS] if self.mode == "matched" else []
        route.fulfill(
            status=200,
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
            body=json.dumps(scoped_response(
                documents,
                scope_state="matched" if self.mode == "matched" else "empty",
            )),
        )


def scroll_result_area_into_view(page, selector: str) -> None:
    """Put the result area at the top of the frame, deterministically."""
    page.evaluate(
        """(selector) => {
            const target = selector.split(',').map((part) => document.querySelector(part.trim()))
                .find(Boolean);
            if (!target) return;
            const top = target.getBoundingClientRect().top + window.scrollY - 8;
            window.scrollTo({ top: Math.max(top, 0), behavior: 'instant' });
        }""",
        selector,
    )
    page.wait_for_timeout(400)


def observed_state(page) -> dict[str, object]:
    """What a reader can see: rendered references, and any disclosed coverage."""
    pins = [
        text.replace("PIN ", "").strip()
        for text in page.locator("#list .money-row-card .pin").all_inner_texts()
        if text.startswith("PIN ")
    ]
    receipt = page.locator("[data-contracts-scope-receipt]").first
    disclosed = None
    if receipt.count():
        disclosed = {
            "outcome": receipt.get_attribute("data-scope-outcome"),
            "match_mode": receipt.get_attribute("data-scope-match-mode"),
            "capability": receipt.get_attribute("data-scope-capability"),
            "lenses": receipt.get_attribute("data-scope-lenses"),
            "coverage_state": receipt.get_attribute("data-scope-coverage-state"),
            "fallback": receipt.get_attribute("data-scope-fallback"),
            "copy": receipt.inner_text().strip(),
        }
    body = page.locator("#list").inner_text()
    return {
        "rendered_references": pins,
        "rendered_row_count": page.locator("#list .money-row-card").count(),
        "scope_receipt": disclosed,
        "shows_nothing_found": "Nothing found" in body,
    }


def capture_scenario(context, stub, out: Path, *, name, route, mode, suffix) -> dict[str, object]:
    stub.mode = mode
    before = len(stub.requests)
    page = context.new_page()
    page.goto(route, wait_until="domcontentloaded", timeout=30_000)
    # Settle: the static-first paint lands first, the scoped answer after it.
    page.wait_for_timeout(4_000)
    # Frame the result area: the evidence is the rows and the disclosure, not the
    # masthead, and a 390px viewport shows the masthead alone above the fold.
    scroll_result_area_into_view(page, "#list")
    file_name = f"{name}-{suffix}.png"
    page.screenshot(path=out / file_name, animations="disabled", full_page=False)
    issued = [url for url in stub.requests[before:]]
    state = observed_state(page)
    page.close()
    return {
        "scenario": name,
        "route": route.split("://", 1)[-1].split("/", 1)[-1],
        "capability_mode": mode,
        "capture": file_name,
        "search_requests": [urlparse(url).query for url in issued],
        "requested_scope": sorted({
            lens
            for url in issued
            for lens in parse_qs(urlparse(url).query).get("scope", [])
        }),
        **state,
    }


def capture_search_front_door(context, stub, out: Path, base_url: str, suffix: str) -> dict[str, object]:
    """The same query at the search front door, for the handoff comparison."""
    stub.mode = "matched"
    before = len(stub.requests)
    page = context.new_page()
    page.goto(f"{base_url}search/?q={QUERY}", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_timeout(4_000)
    scroll_result_area_into_view(page, "[data-search-results], #results, main")
    file_name = f"search-front-door-{suffix}.png"
    page.screenshot(path=out / file_name, animations="disabled", full_page=False)
    text = page.locator("body").inner_text()
    rendered = [case["pin"] for case in DOCUMENTS if case["pin"] in text or case["title"] in text]
    issued = stub.requests[before:]
    page.close()
    return {
        "scenario": "search-front-door",
        "route": f"/search/?q={QUERY}",
        "capability_mode": "matched",
        "capture": file_name,
        "search_requests": [urlparse(url).query for url in issued],
        "rendered_references": rendered,
    }


def base_revision() -> str:
    """The revision the `before` phase is the unmodified state of.

    Both phases name the same base so the two receipts stay comparable across
    rebases and amends of the change itself.
    """
    for command in (
        ["git", "merge-base", "HEAD", "origin/main"],
        ["git", "rev-parse", "HEAD"],
    ):
        try:
            return subprocess.run(
                command, cwd=ROOT, capture_output=True, text=True, check=True,
            ).stdout.strip()
        except Exception:  # pragma: no cover - evidence should never fail on git
            continue
    return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--phase", choices=("before", "after"), default="after")
    parser.add_argument(
        "--base-revision", default=None,
        help="the revision the before phase is the unmodified state of",
    )
    parser.add_argument(
        "--site-dir", type=Path, default=ROOT / "_site",
        help="the prepared public site tree (tools/prepare_functional_site.sh)",
    )
    args = parser.parse_args()
    out: Path = args.out / args.phase
    out.mkdir(parents=True, exist_ok=True)

    site_dir: Path = args.site_dir
    if not (site_dir / "browse" / "contracts" / "index.html").exists():
        raise SystemExit(
            f"{site_dir} is not a prepared public site; run tools/prepare_functional_site.sh first",
        )
    verify = load_performance_helpers()
    stub = CapabilityStub()
    scenarios: list[dict[str, object]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        # Serve the built public artifact: the client imports capability modules
        # that only the Pages-shaped tree carries.
        with verify.StaticServer(site_dir) as base_url:
            for width, height in VIEWPORTS:
                suffix = "mobile-390" if width == 390 else "desktop-1440"
                context = browser.new_context(viewport={"width": width, "height": height})
                # The API origin and its worker fallback: the two hosts the site
                # actually calls for search today.
                for pattern in (
                    "**/api.cityscroll.org/**",
                    "**/cityscroll-worker.crol-worker.workers.dev/**",
                ):
                    context.route(pattern, stub.handle)
                context.route("**/data/procurement_browse_query.json", bounded_query_manifest)
                scenarios.append(capture_scenario(
                    context, stub, out,
                    name="contracts-query",
                    route=f"{base_url}browse/contracts/?mode=award&q={QUERY}",
                    mode="matched", suffix=suffix,
                ))
                scenarios.append(capture_scenario(
                    context, stub, out,
                    name="contracts-provider-failure",
                    route=f"{base_url}browse/contracts/?mode=award&q={QUERY}",
                    mode="provider_failure", suffix=suffix,
                ))
                scenarios.append(capture_scenario(
                    context, stub, out,
                    name="contracts-provider-failure-snapshot-fallback",
                    route=f"{base_url}browse/contracts/?mode=award&q={FALLBACK_QUERY}",
                    mode="provider_failure", suffix=suffix,
                ))
                scenarios.append(capture_scenario(
                    context, stub, out,
                    name="contracts-empty",
                    route=f"{base_url}browse/contracts/?mode=award&q={EMPTY_QUERY}",
                    mode="empty", suffix=suffix,
                ))
                scenarios.append(capture_search_front_door(context, stub, out, base_url, suffix))
                context.close()
        browser.close()

    receipt = {
        "schema": SCHEMA,
        "phase": args.phase,
        "base_revision": args.base_revision or base_revision(),
        "source_state": (
            "runtime modules unchanged at base_revision"
            if args.phase == "before"
            else "runtime modules carrying the Contracts scoped-adapter change"
        ),
        "viewports": [width for width, _height in VIEWPORTS],
        "registered_scope": {"lenses": list(SCOPE_LENSES), "domains": ["contracts"]},
        "query": QUERY,
        "scenarios": scenarios,
    }
    (args.out / f"{args.phase}-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8",
    )
    print(f"Captured {len(scenarios)} scoped-adapter scenarios under {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
