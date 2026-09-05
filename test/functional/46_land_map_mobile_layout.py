#!/usr/bin/env python3
"""Browser proof that Land's Map and List stay usable on a narrow screen.

LM-07 proved a marker pairs with a focusable summary; LM-09 proved boundary context.
Neither was driven at a phone width with touch. This card is the narrow-screen contract:
the switch, the filtered-population counts, the unmapped accounting, and a List exit must
all be reachable without horizontal overflow, and a touch tap -- never a hover -- must
reveal a marker's identity, method, precision, and canonical detail access. Four fixtures
(320, 375, 768, and desktop) prove the same canonical model and counts hold at every width,
and that CSS reflow changed arrangement, not membership.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]

BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
MAP_ROUTE = "/browse/zoning/?view=map"
FILTERED_MAP_ROUTE = "/browse/zoning/?boro=Queens&view=map"

# A 25-lot rezoning: on the map, and emphatically not at an address (LM-07's anchor).
ANCHOR_SPECIMEN = "2025K0305"
# The one project genuinely lacking a retained BBL (site/data/land_project_map_points_receipt.json)
# -- reachable only through the List.
UNMAPPED_SPECIMEN = "2025M0252"
# Derived from the committed join receipt rather than pinned, so a future resolver refresh
# that legitimately changes how many of the 40 Land projects resolve to a map point updates
# this expectation from its own source instead of drifting silently against a stale number.
_RECEIPT = json.loads((ROOT / "site" / "data" / "land_project_map_points_receipt.json").read_text())
EXPECTED_TOTAL = _RECEIPT["counts"]["universe"]
EXPECTED_MAPPED = _RECEIPT["counts"]["mapped"]
EXPECTED_UNMAPPED = EXPECTED_TOTAL - EXPECTED_MAPPED

# The registered fixtures, plus the desktop regression width.
FIXTURES = ((320, 568), (375, 667), (768, 1024), (1440, 900))


def install_routes(page) -> None:
    """Offline and self-contained, exactly as the marker-selection proof does."""
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


def new_page(browser, width: int, height: int):
    context = browser.new_context(viewport={"width": width, "height": height}, has_touch=True)
    page = context.new_page()
    install_routes(page)
    return context, page


def wait_for_map(page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)


def marker(page, project_id: str):
    return page.locator(f'#land-map-panel [role="button"][data-land-map-project="{project_id}"]')


def read_layout(page) -> dict:
    return page.evaluate(
        """() => {
          const doc = document.documentElement;
          const inViewport = (el) => {
            if (!el) return false;
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.right <= window.innerWidth + 1;
          };
          const switchChips = [...document.querySelectorAll('#land-view-switch [data-land-view]')];
          const summary = document.getElementById('land-map-summary');
          const listLink = document.querySelector('.land-map-list-link');
          return {
            overflow: doc.scrollWidth - doc.clientWidth,
            switch_present: switchChips.length === 2,
            switch_reachable: switchChips.every(inViewport),
            switch_pressed: switchChips.map((el) => el.getAttribute('aria-pressed')),
            total: summary ? Number(summary.dataset.landMapTotal) : null,
            mapped: summary ? Number(summary.dataset.landMapMapped) : null,
            unmapped: summary ? Number(summary.dataset.landMapUnmapped) : null,
            summary_reachable: inViewport(summary),
            list_link_present: Boolean(listLink),
            list_link_reachable: inViewport(listLink),
            list_link_href: listLink ? listLink.getAttribute('href') : null,
            list_rows: document.querySelectorAll('#llist .row').length,
          };
        }"""
    )


def read_selection(page) -> dict:
    return page.evaluate(
        """(id) => {
          const summary = document.getElementById('land-map-selected');
          const inViewport = (el) => {
            if (!el) return false;
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.right <= window.innerWidth + 1;
          };
          return {
            has_summary: Boolean(summary),
            focus_kind: document.activeElement?.id === 'land-map-selected' ? 'summary' : (document.activeElement?.id || document.activeElement?.tagName || null),
            title: summary ? summary.querySelector('.land-map-selected-title')?.textContent?.trim() : null,
            placement: summary ? summary.querySelector('.land-map-selected-placement')?.textContent?.trim() : null,
            detail_href: summary ? summary.querySelector('.land-map-selected-detail')?.getAttribute('href') : null,
            detail_names_project: Boolean(
              summary && (summary.querySelector('.land-map-selected-detail')?.getAttribute('href') || '').includes(id)
            ),
            reachable: summary ? inViewport(summary) : false,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        }""",
        ANCHOR_SPECIMEN,
    )


def check_fixture(browser, width: int, height: int) -> None:
    context, page = new_page(browser, width, height)
    try:
        page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
        wait_for_map(page)

        # A1: switch, counts, unmapped accounting, and a List exit -- all without overflow.
        layout = read_layout(page)
        assert layout["overflow"] <= 1, f"{width}px: horizontal overflow of {layout['overflow']}px"
        assert layout["switch_present"] and layout["switch_reachable"], (width, layout)
        assert layout["total"] == EXPECTED_TOTAL, (width, layout)
        assert layout["mapped"] == EXPECTED_MAPPED, (width, layout)
        assert layout["unmapped"] == EXPECTED_UNMAPPED, (width, layout)
        assert layout["list_link_present"] and layout["list_link_reachable"], (width, layout)
        assert layout["list_link_href"], f"{width}px: the List exit has no shareable href"
        assert layout["list_rows"] == EXPECTED_TOTAL, "the List denominator dropped a row"

        # A2: a touch tap -- never a hover -- reveals identity, method, precision, and detail.
        marker(page, ANCHOR_SPECIMEN).tap()
        page.wait_for_selector("#land-map-selected", timeout=15_000)
        selection = read_selection(page)
        assert selection["has_summary"], (width, "tap produced no summary")
        assert selection["focus_kind"] == "summary", (width, selection["focus_kind"])
        assert selection["title"], (width, "the summary has no project title")
        assert selection["placement"] and "not an exact address" in selection["placement"], (
            width, selection["placement"])
        assert selection["detail_names_project"], (width, selection["detail_href"])
        assert selection["reachable"], (width, "the selected summary overflowed")
        assert selection["overflow"] <= 1, f"{width}px: selection overflowed by {selection['overflow']}px"

        # A1/A4: the unmapped specimen never gets a marker, and stays in the List denominator.
        assert marker(page, UNMAPPED_SPECIMEN).count() == 0, (width, "an unplaced project got a marker")

        # A1: the unconditional List exit switches presentation without losing rows.
        page.locator(".land-map-list-link").tap()
        page.wait_for_function(
            "() => document.getElementById('land-results-grid')?.dataset.landView === 'list'",
            timeout=15_000,
        )
        after_handoff = page.evaluate(
            """(id) => ({
              map_mounted: Boolean(document.getElementById('land-map-panel')),
              rows: document.querySelectorAll('#llist .row').length,
              unmapped_row_present: Boolean([...document.querySelectorAll('#llist .row')]
                .find((row) => row.outerHTML.includes(id))),
            })""",
            UNMAPPED_SPECIMEN,
        )
        assert after_handoff["map_mounted"] is False, (width, "the List exit left the Map mounted")
        assert after_handoff["rows"] == EXPECTED_TOTAL, (width, after_handoff)

        # A4: back to Map, then a canonical detail visit, then back -- no overflow either side.
        page.locator('#land-view-switch [data-land-view="map"]').tap()
        wait_for_map(page)
        marker(page, ANCHOR_SPECIMEN).tap()
        page.wait_for_selector("#land-map-selected", timeout=15_000)
        page.locator(".land-map-selected-detail").tap()
        page.wait_for_function(
            "(id) => location.hash.includes(`#land/${id}`)", arg=ANCHOR_SPECIMEN, timeout=20_000)
        page.wait_for_function(
            "() => document.getElementById('land-item-card').hidden === false", timeout=30_000)
        page.go_back()
        wait_for_map(page)
        page.wait_for_selector("#land-map-selected", timeout=20_000)
        back = read_layout(page)
        assert back["overflow"] <= 1, (width, "overflowed after Back")
        assert back["total"] == EXPECTED_TOTAL, (width, "Back changed the filtered population")
        back_selection = page.evaluate(
            "() => document.getElementById('land-map-panel')?.dataset.landMapSelected || null"
        )
        assert back_selection == ANCHOR_SPECIMEN, (width, "Back forgot which project was selected")

        print(f"{width}x{height}: OK", json.dumps(
            {"overflow": layout["overflow"], "total": layout["total"], "unmapped": layout["unmapped"]}))
    finally:
        context.close()


def check_filtered_population_keeps_the_same_model(browser) -> None:
    """A one-project filter is a smaller population, never a different model."""
    context, page = new_page(browser, 375, 667)
    try:
        page.goto(f"{BASE}{FILTERED_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
        wait_for_map(page)
        layout = read_layout(page)
        assert layout["overflow"] <= 1, layout
        assert layout["total"] < EXPECTED_TOTAL, "the borough filter did not narrow the population"
        assert layout["total"] == layout["list_rows"], "the map summary and the List disagree on the count"
        print("filtered-375px: OK", json.dumps({"total": layout["total"]}))
    finally:
        context.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in FIXTURES:
            check_fixture(browser, width, height)
        check_filtered_population_keeps_the_same_model(browser)
        browser.close()
    print("land map mobile layout OK: 320/375/768/1440, overflow, touch selection, List exit, back navigation")


if __name__ == "__main__":
    main()
