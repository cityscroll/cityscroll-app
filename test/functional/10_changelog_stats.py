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
    health = page.locator('a[href$="data-health/"], a[href="/data-health/"], a[href="data-health/"]')
    assert health.count() == 0
    print("OK stats page remains available without a Data health link")

    # The coverage section is materialised, not fetched from a publisher, so it must paint
    # from the static snapshot alone.
    page.wait_for_selector("#coverage section.cov-domain table.cov tbody tr", timeout=15000)
    domains = page.locator("#coverage section.cov-domain")
    assert domains.count() >= 5, f"expected several served domains, saw {domains.count()}"
    rows = page.locator("#coverage table.cov tbody tr")
    assert rows.count() >= 15, f"expected the served record sets to render, saw {rows.count()}"
    for column in ("Record type", "Records", "Source", "Counted by", "Evidence as of"):
        assert page.locator(f"#coverage table.cov thead th:text-is('{column}')").count() >= 1, column
    # Every counted row states the date of the evidence it was counted from.
    counted = page.locator("#coverage table.cov tbody tr")
    for index in range(counted.count()):
        cells = counted.nth(index).locator("th, td")
        assert cells.nth(4).inner_text().strip(), "a counted record set rendered without an evidence date"
    for gone in ("Published notice rows", "Main public data sets", "Latest publication date"):
        assert page.locator(f"text='{gone}'").count() == 0, f"{gone} should be replaced by served coverage"
    print(f"OK stats page renders {domains.count()} served coverage domains with dated counts")

    browser.close()
