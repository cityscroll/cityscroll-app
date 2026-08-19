"""Reciprocal Stats ↔ Data health links stay on the public surfaces."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
DATA_HEALTH = Path(__file__).resolve().parents[2] / "site" / "data-health" / "index.html"

with sync_playwright() as pw:
    system_chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    launch_options = {"executable_path": system_chrome} if os.path.exists(system_chrome) else {}
    browser = pw.chromium.launch(**launch_options)
    page = browser.new_page()

    page.goto(BASE + "stats.html", timeout=30000)
    page.wait_for_selector(".stats-data-health-crosslink", timeout=15000)
    link = page.locator(".stats-data-health-crosslink a[href$='data-health/']")
    assert link.count() == 1
    assert "Data health" in (link.inner_text() or "")
    print("OK stats page names Data health")

    if DATA_HEALTH.is_file():
        page.goto(BASE + "data-health/", timeout=30000)
        back = page.locator('a[href$="stats.html"], a[href="/stats.html"]')
        assert back.count() >= 1
        print("OK data-health page names Stats")
    else:
        print("OK data-health page not in this tree; stats-side link is present")

    browser.close()
