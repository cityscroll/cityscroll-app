"""Public Data health stays gated off until source clocks are complete."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")


def test_data_health_page():
    with sync_playwright() as pw:
        system_chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        launch_options = {"executable_path": system_chrome} if os.path.exists(system_chrome) else {}
        browser = pw.chromium.launch(**launch_options)
        page = browser.new_page()
        response = page.goto(BASE + "data-health/", timeout=30000)
        assert response is not None
        assert response.status == 404
        html = page.content()
        assert "data-data-health=\"ready\"" not in html
        assert "data-health-card" not in html
        print("OK public data-health path is not-found while the visibility gate is off")
        browser.close()


if __name__ == "__main__":
    test_data_health_page()
