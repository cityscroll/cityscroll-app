"""Resident Data health page is materialize-first and anti-slop."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")


def test_data_health_page():
    with sync_playwright() as pw:
        system_chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        launch_options = {"executable_path": system_chrome} if os.path.exists(system_chrome) else {}
        browser = pw.chromium.launch(**launch_options)
        page = browser.new_page()
        page.goto(BASE + "data-health/", timeout=30000)
        page.wait_for_selector("main[data-data-health='ready']", timeout=15000)

        assert page.locator("h1").inner_text().strip().lower() == "data health"
        body = page.locator("body").inner_text()
        html = page.content()
        assert "Publisher updated" in html
        assert "CityScroll last checked" in html
        assert "CityScroll serving copy" in html
        assert "Coverage" in html
        assert "UNKNOWN" in html
        assert "all operational" not in body.lower()
        assert "data may be incomplete" not in body.lower()
        assert "join_coverage" not in html
        assert "snapshot_sha" not in html
        assert "date_reported_as_of" not in html
        assert "Official source" not in html
        assert "Source unavailable" not in html
        assert "1970" not in html
        assert page.locator(".data-health-condition").count() >= 1
        assert page.locator(".data-health-coverage").count() >= 1
        mobile = browser.new_page(viewport={"width": 390, "height": 844})
        mobile.goto(BASE + "data-health/", timeout=30000)
        mobile.wait_for_selector("main[data-data-health='ready']", timeout=15000)
        assert mobile.locator("h1").inner_text().strip().lower() == "data health"
        assert mobile.locator(".data-health-card").count() >= 1
        print("OK data health page renders clocks, coverage, and honest UNKNOWN")
        browser.close()


if __name__ == "__main__":
    test_data_health_page()
