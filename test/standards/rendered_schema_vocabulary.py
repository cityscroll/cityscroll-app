#!/usr/bin/env python3
"""Catalog implementation vocabulary on rendered resident surfaces.

The catalog has two independent surface passes:

* ``default_document`` covers every current ``site/**/*.html`` build product.
* ``route_state`` covers the finite document, route, tab, facet, and scope matrix.

Each pass records default reader copy separately from text behind a closed ``details``
affordance. Findings are grouped by surface family and leak category. A finding is an
error unless it matches a reviewed, named entry in the adjacent exception register.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
from typing import Any

from playwright.sync_api import Page, sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
SITE = ROOT / "site"
from resident_surface_catalog import (  # noqa: E402
    DEFAULT_ALLOWLIST,
    classify_surface_family,
    findings_for_text,
    load_allowlist,
    print_report,
    summarize,
)
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/")
if not BASE.endswith("/"):
    BASE += "/"

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
    "notices/20260527036",
    "agencies/housing-preservation-and-development/?tab=forecast",
    "vendors/CAMBA/",
    "officials/7801/",
    "community-boards/bronx-cb-01/",
    "agencies/office-of-the-mayor/",
    "parcels/1000730008/",
    "community-boards/bronx-cb-02/",
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

NEAR_YOU_STATES = (
    ("near-you:default", "near-you/"),
    ("near-you:meetings", "near-you/#meetings"),
    ("near-you:money", "near-you/#money"),
    ("near-you:map-city", "near-you/#map?level=citywide&lens=meetings"),
    ("near-you:map-borough", "near-you/#map?level=borough&parent=Brooklyn&lens=money"),
    ("near-you:map-community-district", "near-you/#map?level=community_district&parent=Brooklyn&id=K02&lens=meetings"),
    ("near-you:map-council-district", "near-you/#map?level=council_district&parent=Brooklyn&id=35&lens=property"),
)

FOLLOWING_STATES = (
    ("following:default", "following/"),
    ("following:create", "following/#create"),
    ("following:your-following", "following/#your-following"),
)

def default_reader_text(page: Page) -> str:
    return page.locator("body").inner_text()


def opt_in_disclosure_text(page: Page) -> str:
    """Return closed-details content without changing the default reader pass."""
    return page.evaluate(
        """
        () => Array.from(document.querySelectorAll('details:not([open]):not([hidden])'))
          .map((details) => {
            const clone = details.cloneNode(true);
            clone.querySelectorAll('summary, script, style, template, [hidden]').forEach((node) => node.remove());
            return clone.textContent || '';
          })
          .join('\\n')
        """
    )


def add_surface_records(
    page: Page,
    records: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    *,
    surface_id: str,
    source: str,
    surface_kind: str,
    family: str,
) -> None:
    base = {
        "surface": surface_id,
        "source": source,
        "surface_kind": surface_kind,
        "surface_family": family,
    }
    default = {**base, "content_mode": "default_reader"}
    records.append({**default, "findings": findings_for_text(default_reader_text(page), default, entries)})
    disclosure_text = opt_in_disclosure_text(page)
    if disclosure_text.strip():
        disclosure = {**base, "content_mode": "opt_in_disclosure"}
        records.append({**disclosure, "findings": findings_for_text(disclosure_text, disclosure, entries)})


def visit(
    page: Page,
    records: list[dict[str, Any]],
    errors: list[dict[str, str]],
    entries: list[dict[str, Any]],
    *,
    surface_id: str,
    source: str,
    surface_kind: str,
    family: str,
    wait_ms: int,
) -> None:
    try:
        page.goto(BASE + source, wait_until="load", timeout=30_000)
        page.wait_for_timeout(wait_ms)
        add_surface_records(
            page,
            records,
            entries,
            surface_id=surface_id,
            source=source,
            surface_kind=surface_kind,
            family=family,
        )
    except Exception as exc:
        errors.append({"surface": surface_id, "error": f"{type(exc).__name__}: {str(exc)[:180]}"})


def visit_source(
    page: Page,
    records: list[dict[str, Any]],
    errors: list[dict[str, str]],
    entries: list[dict[str, Any]],
    *,
    surface_id: str,
    source: str,
    surface_kind: str = "default_document",
) -> None:
    html = pathlib.Path(source).read_text(encoding="utf-8") if surface_id.startswith("fixture:") else (SITE / (source or "index.html")).read_text(encoding="utf-8")
    html = re.sub(r"<script\b[\s\S]*?</script\s*>", "", html, flags=re.I)
    html = re.sub(r"<style\b[\s\S]*?</style\s*>", "", html, flags=re.I)
    try:
        page.set_content(html, wait_until="domcontentloaded", timeout=15_000)
        add_surface_records(
            page,
            records,
            entries,
            surface_id=surface_id,
            source=source,
            surface_kind=surface_kind,
            family=classify_surface_family(pathlib.Path(source).name if surface_id.startswith("fixture:") else source, surface_id),
        )
    except Exception as exc:
        errors.append({"surface": surface_id, "error": f"{type(exc).__name__}: {str(exc)[:180]}"})


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allowlist", type=pathlib.Path, default=DEFAULT_ALLOWLIST)
    parser.add_argument("--json", action="store_true", help="Write the complete catalog to stdout.")
    parser.add_argument("--report", type=pathlib.Path, help="Write the complete catalog to this path.")
    parser.add_argument("--fixture", type=pathlib.Path, action="append", default=[], help="Catalog a standalone HTML fixture instead of the public surface inventory.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        entries = load_allowlist(args.allowlist)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"resident-surface allowlist error: {exc}", file=sys.stderr)
        return 2

    records: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context()
        page = context.new_page()
        install_routes(page)

        if args.fixture:
            for fixture in args.fixture:
                visit_source(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=f"fixture:{fixture.name}",
                    source=str(fixture),
                )
        else:
            for path in STATIC_DOCUMENTS:
                visit_source(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=f"built:{path or 'index.html'}",
                    source=path,
                )
            for path in DOCUMENT_ROUTES:
                state = f"document:{path}"
                visit(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=state,
                    source=path,
                    surface_kind="route_state",
                    family=classify_surface_family(path, state),
                    wait_ms=500,
                )
            for state_name, fragment in ROOT_HASH_STATES:
                state = f"root:{state_name}"
                visit(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=state,
                    source=fragment,
                    surface_kind="route_state",
                    family=classify_surface_family(fragment, state),
                    wait_ms=800,
                )
            for state_name, path in NEAR_YOU_STATES + FOLLOWING_STATES:
                visit(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=state_name,
                    source=path,
                    surface_kind="route_state",
                    family=classify_surface_family(path, state_name),
                    wait_ms=500,
                )

        context.close()
        browser.close()

    report = summarize(records, errors)
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8")
    if args.json:
        print(rendered, end="")
    else:
        print_report(report)
    return 1 if report["unreviewed_findings"] or report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
