"""Verify the City Record coverage view and match-bucket drill-through."""

from __future__ import annotations

import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")


def wait_for_contracts_analytics(page) -> None:
    page.wait_for_selector("#contracts-analytics-groups a", timeout=60000)
    page.wait_for_function(
        "() => document.querySelector('#contracts-analytics-groups a') && "
        "document.querySelector('#contracts-analytics-coverage')",
        timeout=60000,
    )


def open_coverage(page) -> None:
    coverage = page.locator("#contracts-analytics-coverage")
    if coverage.get_attribute("open") is None:
        coverage.locator("summary").click()
    page.wait_for_function(
        "() => document.querySelector('#contracts-analytics-coverage')?.open === true",
        timeout=60000,
    )


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.route("https://**/*", lambda route: route.abort())
        page.goto(f"{BASE}/browse/contracts/?mode=award", wait_until="domcontentloaded", timeout=60000)
        wait_for_contracts_analytics(page)
        groups_box = page.locator("#contracts-analytics-groups").bounding_box()
        coverage_box = page.locator("#contracts-analytics-coverage").bounding_box()
        assert groups_box and coverage_box
        assert groups_box["y"] < coverage_box["y"]
        assert page.locator("#contracts-analytics-coverage").get_attribute("open") is None
        assert "Data coverage/methodology" in page.locator("#contracts-analytics-coverage-disclosure").inner_text()
        assert page.locator("#contracts-analytics-coverage-statement").is_hidden()

        open_coverage(page)
        page.wait_for_function(
            "() => document.querySelector('#contracts-analytics-coverage-statement')?.textContent.includes('eligible contracts')",
            timeout=60000,
        )
        statement = page.locator("#contracts-analytics-coverage-statement").inner_text()
        assert "CityScroll found an exact notice" in statement
        assert "cannot be evaluated because their PIN is missing" in statement
        assert "legal noncompliance" not in statement.lower()
        assert "city failed" not in statement.lower()
        assert page.locator("#analytics-coverage-threshold").input_value() == "100000"
        assert page.locator("#contracts-analytics-coverage-groups tr").count() > 0
        summary = page.locator("#contracts-analytics-coverage-summary").inner_html()
        assert "Exact notice found" in summary
        assert "No exact notice found" in summary
        assert "Missing PIN" in summary

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

        page.goto(f"{BASE}/browse/contracts/?mode=award", wait_until="domcontentloaded", timeout=60000)
        wait_for_contracts_analytics(page)
        open_coverage(page)
        page.select_option("#analytics-coverage-band", "Under $100,000")
        page.wait_for_function(
            "() => document.querySelector('#contracts-analytics-coverage-statement')?.textContent.includes('No registered contracts in this selection were evaluated')",
            timeout=60000,
        )
        assert page.locator("#contracts-analytics-coverage-groups tr").count() == 0
        print("PASS: City Record coverage is a secondary disclosure and DHS no-match drill-through reaches Contracts")
        browser.close()


if __name__ == "__main__":
    main()
