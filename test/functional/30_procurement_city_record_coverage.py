"""Verify the City Record coverage view and match-bucket drill-through."""

from __future__ import annotations

import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(f"{BASE}/browse/contracts/?mode=award", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#contracts-analytics-coverage-statement", timeout=60000)
        page.wait_for_function(
            "() => document.querySelector('#contracts-analytics-coverage-statement')?.textContent.includes('eligible contracts')",
            timeout=60000,
        )
        assert page.locator("#analytics-coverage-threshold").input_value() == "100000"
        assert page.locator("#contracts-analytics-coverage-groups tr").count() > 0
        assert "cannot be evaluated because their PIN is missing" in page.locator(
            "#contracts-analytics-coverage-statement"
        ).inner_text()

        dhs = page.locator("#contracts-analytics-coverage-groups tr").filter(
            has_text="Department of Homeless Services"
        )
        assert dhs.count() == 1
        dhs.locator("td").nth(2).locator("a").click()
        page.wait_for_selector("#list .row, #list .empty", timeout=60000)
        page.wait_for_function(
            "() => !document.querySelector('#list .loading') && document.querySelector('#rescount')?.textContent",
            timeout=60000,
        )
        assert "ap_agency=Department+of+Homeless+Services" in page.url
        assert "ap_city_record_match=none" in page.url
        assert page.locator("#list .row").count() > 0
        print("PASS: City Record coverage renders and DHS no-match drill-through reaches Contracts")
        browser.close()


if __name__ == "__main__":
    main()
