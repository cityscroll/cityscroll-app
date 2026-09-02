"""Browser proof for sourced Land Map boundary context (LM-09)."""

from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
ROUTE = "/browse/zoning/?boro=Brooklyn&view=map"
FILTERED_ROUTE = "/browse/zoning/?boro=Brooklyn&family=rezoning&q=school&view=map"


def install_routes(page, *, missing=False):
    def capability_module(route: Route):
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(
        f"{BASE}/capabilities/*",
        capability_module,
    )
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())
    if missing:
        page.route(
            f"{BASE}/data/geography/layers/community_district/*",
            lambda route: route.fulfill(status=404, body=""),
        )


def settle(page):
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.wait_for_function(
        "() => document.querySelectorAll('#llist .row').length > 0 || !!document.querySelector('.land-empty-state')",
        timeout=45_000,
    )
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=45_000)
    page.wait_for_timeout(800)


def read_state(page):
    return page.evaluate(
        """() => {
          const summary = document.getElementById('land-map-summary');
          const panel = document.getElementById('land-map-panel');
          return {
            url: location.pathname + location.search + location.hash,
            counts: summary ? [summary.dataset.landMapTotal, summary.dataset.landMapMapped, summary.dataset.landMapUnmapped] : null,
            markers: [...document.querySelectorAll('.land-map-marker')].map((node) => node.dataset.landMapProject),
            boundary_state: panel?.dataset?.landMapBoundaryState || null,
          };
        }"""
    )


def test_boundary_context_is_sourced_and_explicit():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        install_routes(page)
        page.goto(f"{BASE}{FILTERED_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
        settle(page)
        before = read_state(page)
        assert before["boundary_state"] == "ready"
        assert set(page.locator("[data-land-boundary-level]").evaluate_all("nodes => nodes.map(node => node.dataset.landBoundaryLevel)")) == {
            "borough", "community_district", "council_district"
        }
        assert page.locator(".land-map-boundary-label").count() == 127
        assert page.locator(".land-map-boundary-outline").count() == 127
        assert page.locator(".land-map-boundary-outline").evaluate_all(
            "nodes => nodes.every(node => node.getAttribute('fill') === 'none' && node.getAttribute('pointer-events') === 'none')"
        )
        assert page.locator(".land-map-boundary-label[data-land-boundary-link='K03']").count() == 1
        assert page.locator(".land-map-boundary-evidence").count() == 1
        page.locator(".land-map-boundary-evidence summary").press("Enter")
        assert "2026-05-26" in page.locator(".land-map-boundary-evidence").inner_text()
        assert "NYC Department of City Planning" in page.locator(".land-map-boundary-evidence").inner_text()
        assert page.locator(".land-map-choropleth, [data-land-map-value], .fill-density").count() == 0

        unchanged_url = page.url
        page.locator(".land-map-boundary-outline").first.dispatch_event("click")
        assert page.url == unchanged_url

        scope = page.locator(".land-map-boundary-label[data-land-boundary-link='K03']")
        scope.focus()
        scope.press("Enter")
        page.wait_for_function("() => location.hash.includes('cd=K03')", timeout=20_000)
        assert "boro=Brooklyn" in page.url
        assert "q=school" in page.url
        browser.close()


def test_missing_boundary_context_preserves_project_markers():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        install_routes(page, missing=True)
        page.goto(f"{BASE}{ROUTE}", wait_until="domcontentloaded", timeout=45_000)
        settle(page)
        state = read_state(page)
        assert state["boundary_state"] == "partial"
        assert state["counts"] == ["40", "12", "28"]
        assert len(state["markers"]) == 12
        assert page.locator("[data-land-boundary-missing='community_district']").count() == 1
        browser.close()


def main() -> None:
    test_boundary_context_is_sourced_and_explicit()
    test_missing_boundary_context_preserves_project_markers()
    print("land map boundary context OK")


if __name__ == "__main__":
    main()
