#!/usr/bin/env python3
"""Served Near You place-first geometry and board-destination proof."""

from __future__ import annotations

import os
from urllib.parse import parse_qsl, urlencode, urlsplit

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000").rstrip("/")
ROUTE = "/near-you/?" + urlencode({"v": "0", "lens": "meetings", "boro": "Brooklyn", "cd": "K15"})


def assert_geometry(page, width, height):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{BASE}{ROUTE}", wait_until="networkidle")
    page.locator("[data-near-you-root]").wait_for()
    page.locator('[data-near-deferred-state="ready"]').first.wait_for(timeout=30000)
    observed = page.evaluate("""(height) => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
      const values = {
        heading: rect("h1"), board: rect(".near-board-link"), topic: rect("[data-scope-axis='topic']"),
        switch: rect("[data-near-surface-switch]"), state: rect("[data-near-surface-panel='list']")
      };
      return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value && {top: value.top, bottom: value.bottom}]));
    }""", height)
    assert observed["board"], observed
    assert all(observed[key] and observed[key]["top"] >= 0 and observed[key]["bottom"] <= height for key in ("heading", "board", "topic", "switch")), observed
    assert observed["state"]["top"] <= height and observed["state"]["bottom"] <= height * 2, observed
    assert page.locator('.near-board-link a[href="/community-boards/brooklyn-cb-15/"]').count() == 1


def query(page):
    return sorted(parse_qsl(urlsplit(page.url).query, keep_blank_values=True))


def assert_transitions(page):
    """A3: one-chip removal and Records/Map preserve unrelated predicates."""
    route = "/near-you/?" + urlencode({"v": "0", "lens": "meetings", "boro": "Brooklyn", "cd": "K15", "agency": "Transportation", "type": "Public Hearings", "q": "curb", "when": "month", "placeRole": "affected_area"})
    page.goto(f"{BASE}{route}", wait_until="networkidle")
    page.locator('[data-near-deferred-state="ready"]').first.wait_for(timeout=30000)
    assert page.locator("details.near-advanced").get_attribute("open") is None
    page.locator('[data-remove-filter="agency"]').click()
    page.wait_for_load_state("networkidle")
    remaining = dict(query(page))
    assert remaining["q"] == "curb" and remaining["type"] == "Public Hearings" and remaining["cd"] == "K15" and "agency" not in remaining
    before = page.url
    page.locator('[data-near-surface="map"]').click()
    assert page.url == before and page.locator('[data-near-surface="map"]').get_attribute("aria-current") == "true"
    page.locator('[data-near-surface="list"]').click()
    assert page.url == before and page.locator('[data-near-surface="list"]').get_attribute("aria-current") == "true"


def assert_journey_and_failure(page):
    """A5: copied URL, explore/back, keyboard retry, no-script, and failed update."""
    page.goto(f"{BASE}{ROUTE}", wait_until="networkidle")
    copied = page.url
    page.goto(copied, wait_until="networkidle")
    page.locator('[data-near-deferred-state="ready"]').first.wait_for(timeout=30000)
    page.locator("details.near-explore summary").press("Enter")
    assert page.locator("details.near-explore").get_attribute("open") is not None
    page.route("**/near-you/deferred.json*", lambda route: route.fulfill(status=200, content_type="application/json", body='{"results_html":null}'))
    page.goto(f"{BASE}{ROUTE}", wait_until="networkidle")
    page.locator('[data-near-deferred-state="error"]').first.wait_for(timeout=30000)
    retry = page.locator('[data-near-recovery="retry"]').last
    retry.focus()
    retry.press("Enter")
    assert urlsplit(page.url).path.rstrip("/") == urlsplit(ROUTE).path.rstrip("/")
    assert sorted(parse_qsl(urlsplit(page.url).query, keep_blank_values=True)) == sorted(parse_qsl(urlsplit(ROUTE).query, keep_blank_values=True))
    page.unroute("**/near-you/deferred.json*")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        assert_geometry(page, 1440, 900)
        assert_geometry(page, 390, 844)
        assert_transitions(page)
        assert_journey_and_failure(page)
        no_script = browser.new_context(viewport={"width": 390, "height": 844}, java_script_enabled=False).new_page()
        no_script.goto(f"{BASE}{ROUTE}", wait_until="domcontentloaded")
        assert no_script.locator("h1").inner_text() == "Brooklyn Community District 15"
        assert no_script.locator('[data-near-surface-switch]').is_visible()
        browser.close()
    print("PASS: served K15 place-first geometry and exact board destination")


if __name__ == "__main__":
    main()
