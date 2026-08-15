#!/usr/bin/env python3
"""Resident lenses render from retained snapshots while publisher APIs are blocked."""

from __future__ import annotations

import os

from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
PUBLISHER_PATTERNS = (
    "**/data.cityofnewyork.us/**",
    "**/data.ny.gov/**",
    "**/geosearch.planninglabs.nyc/**",
    "**/services5.arcgis.com/**",
    "**/rules.cityofnewyork.us/**",
    "**/legistar.council.nyc.gov/**",
    "**/webapi.legistar.com/**",
    "**/www.checkbooknyc.com/**",
    "**/a856-cityrecord.nyc.gov/**",
)
FIRST_PARTY_API_PATTERNS = (
    "**/api.cityscroll.org/**",
    "**/api.crol-list.org/**",
    "**/crol-worker.crol-worker.workers.dev/**",
)
SURFACES = (
    ("contracts", "/browse/contracts/", "#list .row"),
    ("staffing", "/browse/staffing/", "#career-results .career-card, #staffing-notice-list .staffing-hire-row"),
    ("zoning", "/browse/zoning/", "#llist .row"),
    ("property", "/browse/property/?view=archive", "#propertyfeed .fcard, #propertyfeed .property-cluster"),
    ("rules", "/browse/rules/", "#rulesfeed .fcard"),
)


def main() -> None:
    attempted_publishers: list[tuple[str, str]] = []
    active_surface = {"name": "boot"}

    def block_publisher(route: Route) -> None:
        attempted_publishers.append((active_surface["name"], route.request.url))
        route.abort("blockedbyclient")

    def unavailable_snapshot_api(route: Route) -> None:
        route.fulfill(status=503, content_type="application/json", body='{"ok":false}')

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        for pattern in PUBLISHER_PATTERNS:
            context.route(pattern, block_publisher)
        for pattern in FIRST_PARTY_API_PATTERNS:
            context.route(pattern, unavailable_snapshot_api)

        for name, path, selector in SURFACES:
            active_surface["name"] = name
            page = context.new_page()
            page.goto(BASE + path, wait_until="domcontentloaded", timeout=30_000)
            try:
                page.locator(selector).first.wait_for(state="visible", timeout=30_000)
            except PlaywrightTimeoutError as error:
                excerpt = page.locator("body").inner_text()[:1_000]
                raise AssertionError(f"{name} did not render {selector}: {excerpt}") from error
            body = page.locator("body").inner_text()
            assert "Could not reach NYC Open Data" not in body, name
            assert "No se pudo conectar a NYC Open Data" not in body, name
            page.close()

        browser.close()

    unexpected = [
        item for item in attempted_publishers
        if not (item[0] == "zoning" and item[1].startswith("https://geosearch.planninglabs.nyc/"))
    ]
    assert unexpected == [], unexpected
    assert len(attempted_publishers) <= 1, attempted_publishers
    print("PASS: resident lenses rendered with publisher APIs blocked; only exact geocoder decision debt was attempted")


if __name__ == "__main__":
    main()
