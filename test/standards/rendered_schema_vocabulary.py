#!/usr/bin/env python3
"""Fail when implementation-facing vocabulary reaches rendered reader surfaces.

This is a rendered-DOM census because route-driven and tab-driven surfaces are built by
JavaScript. ``innerText`` deliberately limits the check to reader-visible copy: data
attributes, accessible provenance, and maintainer hover text are not public body copy.

The inventory is intentionally derived from the built ``site`` tree. That keeps static
documents (including generated entity, exam, parcel, district, and Near-you pages) in
the same gate as the application shell. The route matrix covers the finite route grammar
in ``site/app/routing.mjs`` and representative controls for every scope-owning lens.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import sys
from collections import defaultdict

from playwright.sync_api import Page, sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
SITE = ROOT / "site"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

# Source: the local server contract used by the repository's browser CI job.
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/")
if not BASE.endswith("/"):
    BASE += "/"

# Every built HTML document is a resident-facing route or a generated document route.
# Agency detail HTML is a deploy-time artifact and its lookup is the authoritative
# generated set; this avoids counting stale ignored artifacts left by an older build.
_AGENCY_LOOKUP = json.loads((SITE / "data" / "agency_constellation_lookup.json").read_text(encoding="utf-8"))
_BUILT_AGENCY_IDS = frozenset(_AGENCY_LOOKUP.get("by_id", {}))


def is_current_built_document(path: pathlib.Path) -> bool:
    relative = path.relative_to(SITE).parts
    return not (
        len(relative) == 3
        and relative[0] == "agencies"
        and relative[2] == "index.html"
        and relative[1] not in _BUILT_AGENCY_IDS
    )


STATIC_DOCUMENTS = tuple(
    "" if path.relative_to(SITE).as_posix() == "index.html" else path.relative_to(SITE).as_posix()
    for path in sorted(SITE.rglob("*.html"))
    if is_current_built_document(path)
)

# Source: DOCUMENT_FACET_HASHES, DOCUMENT_CONCEPT_ROUTES, and documentRouteRaw() in
# site/app/routing.mjs. These are edge-rendered documents backed by the shell locally.
DOCUMENT_ROUTES = (
    "now/",
    "browse/",
    "browse/people/",
    "browse/places/",
    "browse/contracts/",
    "browse/staffing/",
    "browse/zoning/",
    "browse/property/",
    "browse/rules/",
    "browse/meetings/",
    "notices/20260701099",
    # Conditional board-outcome panels are mounted on notice documents; this
    # unmatched sample also proves that failed joins do not expose debug fields.
    "notices/20260527036",
    "agencies/housing-preservation-and-development/?tab=forecast",
    "vendors/CAMBA/",
    "officials/7801/",
    # Community board constellation document: board-level place, source, and
    # institution projections use the same resident vocabulary census.
    "community-boards/bronx-cb-01/",
    # Board institution projection: the query carries the publisher body_id and
    # the anchor returns to the board section on the People + organizations page.
    "browse/people/?board=bronx-cb-01#community-boards",
)

# Source: the finite hash grammar in applyHash() and the scope controls declared by
# site/index.html. Query variants exercise states that are not represented by a bare tab.
ROOT_HASH_STATES = (
    ("tab:money-default", "#money"),
    ("tab:money-awards", "#money?mode=award&agency=Housing%20Preservation%20and%20Development"),
    ("tab:money-location", "#money?mode=allrfp&basis=contract_action_address&boro=Brooklyn&cd=K02&council=35"),
    ("tab:people-guide", "#people?view=guide&interest=technology&eligibility=open_competitive&window=actionable"),
    ("tab:people-agency", "#people?agency=Housing%20Preservation%20and%20Development&q=engineer"),
    ("tab:people-history", "#people?window=closed&format=written&salary=45k_60k&fee=low&experience=no"),
    ("tab:land-status", "#land?status=hearings&boro=Queens&cd=Q07&council=26&closing=week"),
    ("tab:land-project", "#land/2024M0193"),
    ("tab:property-scope", "#property?agency=Housing%20Preservation%20and%20Development&boro=Brooklyn&process=disposition&view=archive"),
    ("tab:property-parcel", "#property?facet=%7B%22entity_refs_all%22%3A%5B%22bbl%3A3025180036%22%5D%7D"),
    ("tab:rules-scope", "#rules?agency=Housing%20Preservation%20and%20Development&q=rent"),
    ("tab:meetings-place", "#meetings?when=all&boro=Brooklyn&cd=K02&council=35&process=outcomes&group=place"),
    ("route:notice", "#notice/20260701099"),
    ("route:notice-focus", "#notice/20260701099?focus=follow-the-dollars"),
    ("route:exam", "#exam/6001"),
    ("route:vendor", "#vendor/CAMBA"),
    ("route:agency", "#agency/Housing%20Preservation%20and%20Development?tab=forecast"),
    ("route:official", "#official/7801?event=22526&notice=20260706036"),
    ("route:matter", "#matter/84124P0003001"),
    ("route:investigation", "#investigation"),
    ("route:investigation-shared", "#investigation/shared/INV-1"),
    ("route:task-bid", "#task/can-i-bid"),
    ("route:task-change", "#task/what-will-change"),
    ("route:legacy-alerts", "#alerts"),
    ("route:legacy-map", "#map?level=borough&parent=Brooklyn&lens=meetings"),
    ("route:legacy-staffing", "#staffing?view=guide"),
)

# Source: site/near-you/index.html's map scope grammar and the generated lens pages.
NEAR_YOU_STATES = (
    ("near-you:default", "near-you/"),
    ("near-you:meetings", "near-you/#meetings"),
    ("near-you:money", "near-you/#money"),
    ("near-you:map-city", "near-you/#map?level=citywide&lens=meetings"),
    ("near-you:map-borough", "near-you/#map?level=borough&parent=Brooklyn&lens=money"),
    ("near-you:map-community-district", "near-you/#map?level=community_district&parent=Brooklyn&id=K02&lens=meetings"),
    ("near-you:map-council-district", "near-you/#map?level=council_district&parent=Brooklyn&id=35&lens=property"),
)

# Following has its own static document and hash-controlled create/manage states.
FOLLOWING_STATES = (
    ("following:default", "following/"),
    ("following:create", "following/#create"),
    ("following:your-following", "following/#your-following"),
)
SNAKE_CASE = re.compile(r"\b[a-z]+(?:_[a-z0-9]+)+\b")

# Keep this narrow and evidence-backed. Add an entry only when underscores are genuinely
# reader-facing language rather than an internal field, enum, or identifier.
ALLOWLIST = frozenset({
    # The API reference intentionally presents exact route parameters, response fields,
    # and MCP tool names as code. Their spelling is the contract readers need to call.
    "agency_name", "canonical_id", "canonical_name", "create_watch", "get_notice",
    "preview_watch", "raw_string", "request_id", "search_notices",
})

# These are diagnostic rows, not useful empty-state language. Keep them in the same
# census so a future route cannot hide the symptom behind a non-snake-case string.
DEBUG_PATTERNS = (
    ("unavailable debug copy", re.compile(
        r"(?:\b(?:Source|Source record|Source fields|Join method)\b[^<]{0,100}\bUnavailable\b|\bUnavailable\b\s*</(?:dd|span|p|div)>)",
        re.I,
    )),
    ("reconciliation disclaimer", re.compile(r"This check compares claims", re.I)),
)


def visible_text(page: Page) -> str:
    return page.locator("body").inner_text()


def census(page: Page, state: str, failures: list[tuple[str, list[str], list[str]]]) -> None:
    text = visible_text(page)
    matches = sorted(set(SNAKE_CASE.findall(text)) - ALLOWLIST)
    debug = sorted({label for label, pattern in DEBUG_PATTERNS if pattern.search(text)})
    if matches or debug:
        failures.append((state, matches, debug))
    else:
        if not os.environ.get("CENSUS_QUIET"):
            print(f"OK {state}", flush=True)


def visit(page: Page, state: str, path: str, failures: list[tuple[str, list[str], list[str]]], wait_ms: int = 150) -> None:
    try:
        page.goto(BASE + path, wait_until="load", timeout=30_000)
        page.wait_for_timeout(wait_ms)
        census(page, state, failures)
    except Exception as exc:
        failures.append((state, [f"navigation:{type(exc).__name__}"], [str(exc)[:180]]))


def visit_built_document(page: Page, relative_path: str, failures: list[tuple[str, list[str], list[str]]]) -> None:
    """Read a built document into a browser DOM without re-running its network graph.

    Static documents are the artifact under test; their deferred scripts are covered by
    the route matrix below. Stripping script/style blocks keeps this exhaustive artifact
    walk bounded while preserving exactly the server-rendered reader copy and attributes
    that ``innerText`` exposes.
    """
    source = (SITE / (relative_path or "index.html")).read_text(encoding="utf-8")
    source = re.sub(r"<script\b[\s\S]*?</script\s*>", "", source, flags=re.I)
    source = re.sub(r"<style\b[\s\S]*?</style\s*>", "", source, flags=re.I)
    try:
        page.set_content(source, wait_until="domcontentloaded", timeout=15_000)
        census(page, f"built:{relative_path or 'index.html'}", failures)
    except Exception as exc:
        failures.append((f"built:{relative_path or 'index.html'}", [f"navigation:{type(exc).__name__}"], [str(exc)[:180]]))


def main() -> int:
    failures: list[tuple[str, list[str], list[str]]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context()
        page = context.new_page()
        install_routes(page)

        # First pass: every committed built document, including generated entity and
        # node pages. A 150ms settle is enough for static documents while allowing their
        # progressive chrome to attach before innerText is read.
        for path in STATIC_DOCUMENTS:
            visit_built_document(page, path, failures)

        for path in DOCUMENT_ROUTES:
            visit(page, f"document:{path}", path, failures, wait_ms=500)

        for state, fragment in ROOT_HASH_STATES:
            visit(page, f"root:{state}", fragment, failures, wait_ms=800)

        for state, path in NEAR_YOU_STATES + FOLLOWING_STATES:
            visit(page, state, path, failures, wait_ms=500)

        context.close()
        browser.close()

    if failures:
        term_pages: defaultdict[str, list[str]] = defaultdict(list)
        debug_states: defaultdict[str, list[str]] = defaultdict(list)
        for state, terms, debug in failures:
            for term in terms:
                term_pages[term].append(state)
            for label in debug:
                debug_states[label].append(state)
        print(
            f"rendered schema-vocabulary census FAILED — {len(failures)} surface(s) "
            f"of {len(STATIC_DOCUMENTS) + len(DOCUMENT_ROUTES) + len(ROOT_HASH_STATES) + len(NEAR_YOU_STATES) + len(FOLLOWING_STATES)}:",
            file=sys.stderr,
        )
        print(f"  built documents: {len(STATIC_DOCUMENTS)}", file=sys.stderr)
        print(f"  distinct snake_case terms: {len(term_pages)}", file=sys.stderr)
        for term, states in sorted(term_pages.items()):
            print(f"  TERM {term}: {len(states)} surface(s); {', '.join(states[:5])}", file=sys.stderr)
        for label, states in sorted(debug_states.items()):
            print(f"  DEBUG {label}: {len(states)} surface(s); {', '.join(states[:5])}", file=sys.stderr)
        return 1
    print(
        f"rendered schema-vocabulary census OK — {len(STATIC_DOCUMENTS)} built documents "
        f"and {len(DOCUMENT_ROUTES) + len(ROOT_HASH_STATES) + len(NEAR_YOU_STATES) + len(FOLLOWING_STATES)} route/state surfaces; no leaks"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
