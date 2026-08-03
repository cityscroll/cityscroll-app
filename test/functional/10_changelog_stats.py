"""Deep-link handoff for the retired changelog route, plus stats availability."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")

with sync_playwright() as pw:
    system_chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    launch_options = {"executable_path": system_chrome} if os.path.exists(system_chrome) else {}
    browser = pw.chromium.launch(**launch_options)
    page = browser.new_page()

    page.goto(BASE + "changelog.html?from=legacy#2026-07-02b", wait_until="domcontentloaded")
    page.wait_for_url("**/about.html?from=legacy#2026-07-02b")
    assert page.locator("body").count() == 1
    print("OK retired changelog deep link forwards to About with query and hash")

    page.goto(BASE + "stats.html", timeout=30000)
    page.wait_for_selector("#msg", timeout=15000)
    assert page.locator("h1").count() == 1
    print("OK stats page remains available")

    browser.close()
