#!/usr/bin/env python3
"""Near-you Records/Map switching stays reachable at desktop and mobile widths."""

from __future__ import annotations

import subprocess
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
BASE = ""


def is_visible(page: Page, selector: str) -> bool:
    return page.locator(selector).evaluate(
        "node => getComputedStyle(node).display !== 'none'"
    )


# Before a place is chosen, citywide records come first by design, so the map
# may start below the first viewport; it must then follow them directly.
MAP_REACHED_JS = """([height, maxGap]) => {
  const map = document.querySelector('[data-near-surface-panel="map"]').getBoundingClientRect();
  if (map.top < height) return true;
  const citywide = document.querySelector('.near-special-records[data-near-special-records="entry"]');
  if (!citywide) return false;
  const gap = map.top - citywide.getBoundingClientRect().bottom;
  return gap >= 0 && gap <= maxGap;
}"""
MAXIMUM_MAP_GAP_AFTER_CITYWIDE = 48


def map_reached(page: Page, height: int) -> bool:
    return page.evaluate(MAP_REACHED_JS, [height, MAXIMUM_MAP_GAP_AFTER_CITYWIDE])


def assert_switches(page: Page, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{BASE}/near-you/", wait_until="networkidle")

    switch = page.locator("[data-near-surface-switch]")
    records = switch.locator('[data-near-surface="records"]')
    map_link = switch.locator('[data-near-surface="map"]')
    results = '[data-near-surface-panel="records"]'
    map_panel = '[data-near-surface-panel="map"]'

    assert switch.is_visible(), f"Records/Map switch hidden at {width}px"
    assert page.locator(results).count() == 1
    assert not is_visible(page, results)
    assert is_visible(page, map_panel)
    assert page.locator("[data-near-you-root]").get_attribute("data-near-mobile-surface") == "map"

    map_link.click()
    assert page.locator("[data-near-you-root]").get_attribute("data-near-mobile-surface") == "map"
    assert map_link.get_attribute("aria-current") == "true"
    assert is_visible(page, map_panel)
    assert not is_visible(page, results)
    assert page.evaluate("document.activeElement?.dataset.nearSurface") == "map"
    assert map_reached(page, height), f"the map does not follow the entry at {width}px"

    records.click()
    assert page.locator("[data-near-you-root]").get_attribute("data-near-mobile-surface") == "records"
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
    assert int(page.locator("[data-near-you-root]").get_attribute("data-near-deferred-generation") or "0") >= 1


def assert_topic_change_replaces_resolved_results(page: Page, width: int, height: int) -> None:
    """K15 Staffing→Meetings must not leave a Staffing results region beside Meetings chrome."""
    staffing = "/near-you/?v=0&level=community_district&lens=people&boro=Brooklyn&cd=K15"
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{BASE}{staffing}", wait_until="networkidle")
    page.locator('[data-near-you-root][data-near-deferred-state="ready"]').wait_for(timeout=30000)
    assert page.locator(".near-results").count() == 1
    assert "Staffing" in (page.locator("#near-results-heading").text_content() or "")

    page.locator('[data-near-surface-switch] [data-near-surface="records"]').click()
    page.locator("details.near-advanced").first.click()
    page.locator("select[name='lens']").select_option("meetings")
    page.locator("form.near-form button[type='submit']").click()
    page.locator("[data-near-you-root][data-lens='meetings']").wait_for(timeout=30000)
    page.locator('[data-near-you-root][data-near-deferred-state="ready"]').wait_for(timeout=30000)

    assert "lens=meetings" in page.url
    assert int(page.locator("[data-near-you-root]").get_attribute("data-near-deferred-generation") or "0") >= 1
    assert page.locator("input[name='cd']").input_value() == "K15"
    assert page.locator(".near-results").count() == 1
    heading = page.locator("#near-results-heading").text_content() or ""
    assert "Meetings" in heading
    assert "Staffing" not in heading
    topic = page.locator("[data-scope-axis='topic']").text_content() or ""
    assert "Meetings" in topic
    assert "Staffing" not in topic
    assert page.locator(".near-results:has-text('Staffing')").count() == 0


def main() -> None:
    server = subprocess.Popen(
        ["node", "tools/serve_near_you_capture.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert server.stdout is not None
    global BASE
    BASE = server.stdout.readline().strip().rstrip("/")
    if not BASE:
        server.kill()
        raise RuntimeError("Near You renderer did not announce a base URL")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            assert_switches(page, 1440, 1000)
            assert_switches(page, 390, 844)
            assert_failed_update_recovers(page, 1440, 900, keyboard=False)
            assert_failed_update_recovers(page, 390, 844, keyboard=True)
            assert_topic_change_replaces_resolved_results(page, 1440, 900)
            assert_topic_change_replaces_resolved_results(page, 390, 844)

            no_script = browser.new_context(
                viewport={"width": 1440, "height": 1000},
                java_script_enabled=False,
            ).new_page()
            no_script.goto(f"{BASE}/near-you/", wait_until="domcontentloaded")
            assert no_script.locator("[data-near-surface-switch]").is_visible()
            assert no_script.locator('[data-near-surface-panel="records"]').count() == 1
            assert is_visible(no_script, '[data-near-surface-panel="records"]')
            assert is_visible(no_script, '[data-near-surface-panel="map"]')
            map_href = no_script.locator(
                '[data-near-surface-switch] [data-near-surface="map"]'
            ).get_attribute("href") or ""
            map_url = urlsplit(map_href)
            assert map_url.path.rstrip("/") == "/near-you"
            assert dict(parse_qsl(map_url.query)).get("v") == "0"
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)

    print("PASS: Near-you Records/Map switch is usable at desktop and mobile widths")


if __name__ == "__main__":
    main()
