#!/usr/bin/env python3
"""Near-you Records/Map switching stays reachable at desktop and mobile widths."""

from __future__ import annotations

import os
from urllib.parse import parse_qsl, urlsplit

from playwright.sync_api import Page, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://localhost:8000").rstrip("/")


def is_visible(page: Page, selector: str) -> bool:
    return page.locator(selector).evaluate(
        "node => getComputedStyle(node).display !== 'none'"
    )


def assert_switches(page: Page, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{BASE}/near-you/", wait_until="networkidle")

    switch = page.locator("[data-near-surface-switch]")
    records = page.locator('[data-near-surface="list"]')
    map_link = page.locator('[data-near-surface="map"]')
    results = '[data-near-surface-panel="list"]'
    map_panel = '[data-near-surface-panel="map"]'

    assert switch.is_visible(), f"Records/Map switch hidden at {width}px"
    assert is_visible(page, results)
    assert is_visible(page, map_panel) is (width > 560)

    map_link.click()
    assert page.locator("[data-near-you-root]").get_attribute("data-near-mobile-surface") == "map"
    assert map_link.get_attribute("aria-current") == "true"
    assert is_visible(page, map_panel)
    assert not is_visible(page, results)
    assert page.evaluate("document.activeElement?.dataset.nearSurface") == "map"
    assert page.locator(map_panel).evaluate("node => node.getBoundingClientRect().top") < height

    records.click()
    assert page.locator("[data-near-you-root]").get_attribute("data-near-mobile-surface") == "list"
    assert records.get_attribute("aria-current") == "true"
    assert is_visible(page, results)
    assert not is_visible(page, map_panel)
    assert page.evaluate("document.activeElement?.id") == "near-results-heading"


def assert_failed_update_recovers(page: Page, width: int, height: int, keyboard: bool) -> None:
    """A served document must turn a malformed deferred response into scoped recovery."""
    route = "/near-you/?v=0&lens=meetings&boro=Queens&agency=Transportation&q=curb"
    page.set_viewport_size({"width": width, "height": height})

    def malformed(payload_route):
        payload_route.fulfill(
            status=200,
            content_type="application/json",
            body='{"schema":"cityscroll.near_you_deferred.v1","results_html":null}',
        )

    page.route("**/near-you/deferred.json*", malformed)
    page.goto(f"{BASE}{route}", wait_until="networkidle")
    page.locator('[data-near-deferred-state="error"]').first.wait_for()
    retry = page.locator('[data-near-recovery="retry"]').last
    page.unroute("**/near-you/deferred.json*")
    assert retry.is_visible()
    if keyboard:
        retry.focus()
        assert page.evaluate("document.activeElement?.dataset.nearRecovery === 'retry'")
        retry.press("Enter")
    else:
        retry.click()
    expected = urlsplit(route)
    actual = urlsplit(page.url)
    assert actual.path.rstrip("/") == expected.path.rstrip("/")
    assert sorted(parse_qsl(actual.query, keep_blank_values=True)) == sorted(parse_qsl(expected.query, keep_blank_values=True))
    # Retry keeps the scoped URL. The deferred shell may still show error briefly
    # or may already have recovered to ready after a same-document reload.
    assert page.locator("[data-near-you-root]").count() >= 1
    page.locator('[data-near-you-root][data-near-deferred-state="ready"]').wait_for()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        assert_switches(page, 1440, 1000)
        assert_switches(page, 390, 844)
        assert_failed_update_recovers(page, 1440, 900, keyboard=False)
        assert_failed_update_recovers(page, 390, 844, keyboard=True)

        no_script = browser.new_context(
            viewport={"width": 1440, "height": 1000},
            java_script_enabled=False,
        ).new_page()
        no_script.goto(f"{BASE}/near-you/", wait_until="domcontentloaded")
        assert no_script.locator("[data-near-surface-switch]").is_visible()
        assert is_visible(no_script, '[data-near-surface-panel="list"]')
        assert is_visible(no_script, '[data-near-surface-panel="map"]')
        assert no_script.locator('[data-near-surface="map"]').get_attribute("href") == "#near-map-heading"
        browser.close()

    print("PASS: Near-you Records/Map switch is usable at desktop and mobile widths")


if __name__ == "__main__":
    main()
