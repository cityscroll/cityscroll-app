#!/usr/bin/env python3
"""Browser proof for the Land project-geometry field (lm-17).

An exact single-BBL project may carry an additive, non-interactive parcel outline beside
its existing marker. A multi-BBL project never does -- its retained BBLs have no documented
complete-assemblage relation, so merging them would launder overlap into a footprint. Either
way, the marker, the published counts, and the List are untouched.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from land_map_expectations import expected_counts_for_list  # noqa: E402
from land_map_specimens import find_marker_by_method, find_project_with_parcel_outline  # noqa: E402
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
MAP_ROUTE = "/browse/zoning/?view=map"
# Resolved at runtime from the live render (see resolve_specimens) rather than pinned: which
# project is a single-BBL exact point with a retained shape, or a multi-BBL anchor, moves
# with every data refresh.
POSITIVE_SPECIMEN = ""  # single-BBL exact, with a retained parcel shape.
FALLBACK_SPECIMEN = ""  # multi-BBL anchor, ambiguous relation.


def install_routes(page) -> None:
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{BASE}/capabilities/*", capability_module)
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())


def wait_for_map(page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=45_000)
    page.wait_for_timeout(600)


def observe(page) -> dict:
    return page.evaluate(
        """(ids) => {
          const outlines = [...document.querySelectorAll('.land-map-parcel-outline')];
          const byId = (id) => outlines.find((p) => p.dataset.landMapProject === id) || null;
          const positive = byId(ids.positive);
          const summary = document.getElementById('land-map-summary');
          return {
            outline_count: outlines.length,
            positive_present: !!positive,
            positive_method: positive ? positive.dataset.landMapParcelMethod : null,
            positive_precision: positive ? positive.dataset.landMapParcelPrecision : null,
            positive_interactive: positive ? positive.closest('[role="button"]') !== null : null,
            positive_pointer_events: positive ? getComputedStyle(positive).pointerEvents : null,
            fallback_present: !!byId(ids.fallback),
            marker_count: document.querySelectorAll('#land-map-panel .land-map-marker').length,
            list_ids: [...document.querySelectorAll('#llist a[href*="#land/"]')]
              .map((a) => decodeURIComponent(a.getAttribute('href').split('#land/')[1] || ''))
              .filter(Boolean),
            counts: summary ? {
              total: Number(summary.dataset.landMapTotal),
              mapped: Number(summary.dataset.landMapMapped),
              unmapped: Number(summary.dataset.landMapUnmapped),
            } : null,
          };
        }""",
        {"positive": POSITIVE_SPECIMEN, "fallback": FALLBACK_SPECIMEN},
    )


def main() -> None:
    global POSITIVE_SPECIMEN, FALLBACK_SPECIMEN
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        # Resolve on a throwaway page: finding the positive specimen means clicking through
        # live candidates, which would otherwise spoil the "no outline before inspection" read.
        discovery_page = browser.new_page(viewport={"width": 1440, "height": 900})
        install_routes(discovery_page)
        discovery_page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
        wait_for_map(discovery_page)
        POSITIVE_SPECIMEN = find_project_with_parcel_outline(discovery_page)
        FALLBACK_SPECIMEN = find_marker_by_method(discovery_page, "multi_bbl_anchor")
        discovery_page.close()

        page = browser.new_page(viewport={"width": 1440, "height": 900})
        install_routes(page)
        page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
        wait_for_map(page)
        before = observe(page)
        page.locator(f'[data-land-map-project="{POSITIVE_SPECIMEN}"][role="button"]').click()
        page.wait_for_selector(
            f'.land-map-parcel-outline[data-land-map-project="{POSITIVE_SPECIMEN}"]', timeout=15_000
        )
        reading = observe(page)
        browser.close()

    expected = expected_counts_for_list(reading["list_ids"])
    assert reading["counts"] == expected, (
        f"geometry must not change the published counts: {reading['counts']}"
    )
    assert before["outline_count"] == 0, "parcel geometry loaded before a project was inspected"
    assert reading["outline_count"] == 1, f"expected one inspected parcel outline, saw {reading['outline_count']}"
    assert reading["positive_present"], "the single-BBL specimen must carry a parcel outline"
    assert reading["positive_method"] == "single_bbl_parcel_polygon"
    assert reading["positive_precision"] == "tax_lot_boundary"
    assert reading["positive_interactive"] is False, "a parcel outline must never be its own control"
    assert reading["positive_pointer_events"] == "none", "a parcel outline must never intercept pointer events"
    assert reading["fallback_present"] is False, "a multi-BBL anchor must never carry a shape"
    assert reading["marker_count"] == expected["mapped"], "geometry must not add or remove a single marker"
    print(f"ok land-project-geometry: outlines={reading['outline_count']} counts={reading['counts']}")


if __name__ == "__main__":
    main()
