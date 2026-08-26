"""Verify analytical Contracts drill-throughs survive cold URL loads and in-app clicks."""

from __future__ import annotations

import os
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
AGENCY = "Department of Design and Construction"
VENDOR = "CDW GOVERNMENT LLC"


def wait_for_contracts(page) -> None:
    page.wait_for_selector("#list .row, #list .empty", timeout=60000)
    page.wait_for_function(
        "() => !document.querySelector('#list .loading') && document.querySelector('#rescount')?.textContent",
        timeout=60000,
    )


def assert_scope(page, key: str, value: str, expected_count: int, expected_label: str) -> None:
    assert page.url.split("?", 1)[1].find(f"{key}=") >= 0, page.url
    assert page.url.split(key + "=", 1)[1].split("&", 1)[0] == value.replace(" ", "+"), page.url
    assert page.locator("#list .row").count() == expected_count
    assert page.locator("#list .ragency").count() == expected_count
    if key == "ap_agency":
        assert all(
            expected_label in text
            for text in page.locator("#list .ragency").evaluate_all("els => els.map(el => el.textContent)")
        )
    else:
        assert all(
            expected_label in text
            for text in page.locator("#list .rmeta").evaluate_all("els => els.map(el => el.textContent)")
        )


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.route("https://**/*", lambda route: route.abort())

        for key, value, expected_count in (
            ("ap_agency", AGENCY, 40),
            ("ap_vendor", VENDOR, 20),
        ):
            query = urlencode({"mode": "award", key: value})
            page.goto(f"{BASE}/browse/contracts/?{query}", wait_until="domcontentloaded", timeout=60000)
            wait_for_contracts(page)
            assert_scope(page, key, value.replace("+", " "), expected_count, value)

        page.goto(f"{BASE}/browse/contracts/?{urlencode({'mode': 'award', 'ap_agency': AGENCY})}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#contracts-analytics-concentration:not([hidden])", timeout=60000)
        assert "Who receives this contract value?" in page.locator("#contracts-analytics-concentration-heading").inner_text()
        assert "top 5 vendors' share" in page.locator("#contracts-analytics-concentration-summaries").inner_text().lower()
        assert page.locator("#contracts-analytics-concentration-vendors > li").count() > 0
        vendor_href = page.locator("#contracts-analytics-concentration-vendors .contracts-analytics-concentration-vendor-name a").first.get_attribute("href")
        contracts_href = page.locator(".contracts-analytics-concentration-contracts").first.get_attribute("href")
        assert vendor_href.startswith("/vendors/"), vendor_href
        assert "ap_agency=" in contracts_href and "ap_vendor=" in contracts_href, contracts_href

        page.goto(f"{BASE}/browse/contracts/?mode=award", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#contracts-analytics-groups a", timeout=60000)
        page.locator(f'a[data-analytics-drill-through="{AGENCY}"]').click()
        wait_for_contracts(page)
        assert_scope(page, "ap_agency", AGENCY, 40, AGENCY)

        page.goto(f"{BASE}/browse/contracts/?mode=award", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#contracts-analytics-groups a", timeout=60000)
        page.select_option("#analytics-group", "vendor")
        page.wait_for_selector(f'a[data-analytics-drill-through="{VENDOR}"]', timeout=60000)
        page.locator(f'a[data-analytics-drill-through="{VENDOR}"]').click()
        wait_for_contracts(page)
        assert_scope(page, "ap_vendor", VENDOR, 20, VENDOR)

        page.goto(f"{BASE}/browse/contracts/?mode=award", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#contracts-analytics-groups a", timeout=60000)
        page.select_option("#analytics-view", "timing")
        page.wait_for_function("() => document.querySelector('#contracts-analytics-timing:not([hidden])')", timeout=60000)
        timing_link = page.locator("#contracts-analytics-groups a").first
        assert "retroactive=true" in (timing_link.get_attribute("href") or "")
        timing_link.click()
        wait_for_contracts(page)
        assert "retroactive=true" in page.url

        print("PASS: analytical agency, vendor, and retroactive timing drill-throughs work from cold URLs and in-app links")
        browser.close()


if __name__ == "__main__":
    main()
