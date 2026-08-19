"""Public Stats and home navigation stay off Data health while the gate is off."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")

with sync_playwright() as pw:
    system_chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    launch_options = {"executable_path": system_chrome} if os.path.exists(system_chrome) else {}
    browser = pw.chromium.launch(**launch_options)
    page = browser.new_page()

    page.goto(BASE + "stats.html", timeout=30000)
    page.wait_for_selector("#msg", timeout=15000)
    health = page.locator('a[href$="data-health/"], a[href="/data-health/"], a[href="data-health/"]')
    assert health.count() == 0
    print("OK stats page does not link to Data health while gated")

    page.goto(BASE, timeout=30000)
    home_health = page.locator('a[href$="data-health/"], a[href="/data-health/"], a[href="data-health/"]')
    assert home_health.count() == 0
    print("OK home footer does not link to Data health while gated")

    browser.close()
