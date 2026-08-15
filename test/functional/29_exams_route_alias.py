"""End-to-end parity for the Exams URL alias to the Staffing exam guide."""

from __future__ import annotations

import os
import pathlib
import sys

from playwright.sync_api import expect

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from ci_waits import wait_for_locator  # noqa: E402
from i18n_fixtures import install_routes  # noqa: E402

BASE = os.environ.get("CROL_BASE", "")


def wait_for_guide(page):
    wait_for_locator(page.locator("#career-results .career-card").first, timeout=45_000, label="Exams guide cards")


def run(page):
    install_routes(page)

    page.goto(f"{BASE}browse/exams/", wait_until="domcontentloaded", timeout=30_000)
    wait_for_guide(page)
    assert page.url.rstrip("/").endswith("/browse/exams")
    assert page.locator("#tab-people.active").count() == 1
    assert page.locator("#career-guide").is_visible()
    assert page.locator("#staffing-ledger").get_attribute("hidden") == ""
    assert page.locator("#career-browser-heading").inner_text() == "Civil-service exams"
    assert page.locator("#career-guide .career-kicker").first.text_content().strip() == "Exams"
    assert page.locator("#career-result-count").inner_text().strip()
    assert page.locator("#career-source").inner_text().strip()

    # Search is the Staffing guide input, but its state stays on the Exams URL.
    page.locator("#career-query").fill("Police Officer")
    page.wait_for_function("document.querySelectorAll('#career-results .career-card').length > 0")
    page.wait_for_timeout(500)
    route = page.evaluate("({ pathname: location.pathname, params: Object.fromEntries(new URLSearchParams(location.search)) })")
    assert route["pathname"] == "/browse/exams/", route
    assert route["params"].get("view") == "guide", route
    assert route["params"].get("q") == "Police Officer", route
    assert page.locator("#career-query").input_value() == "Police Officer"
    page.reload(wait_until="domcontentloaded")
    wait_for_guide(page)
    assert page.locator("#career-query").input_value() == "Police Officer"

    # A deep-linked exam still stays on the public Exams URL and uses the guide's
    # selected-card and copy-link behavior.
    page.goto(f"{BASE}browse/exams/#exam/7016", wait_until="domcontentloaded", timeout=30_000)
    page.locator("#career-exam-7016").wait_for(state="visible", timeout=45_000)
    assert page.url.split("#", 1)[0].rstrip("/").endswith("/browse/exams")
    assert page.url.endswith("#exam/7016")
    copy = page.locator("#career-exam-7016 [data-career-copy]")
    expect(copy).to_be_visible()
    copy.click()
    page.wait_for_timeout(100)
    assert page.evaluate("navigator.clipboard.readText()") == page.url.split("#", 1)[0].replace("/browse/exams/", "/exams/7016/")

    # A direct filtered route rehydrates the same guide state instead of a static list.
    page.goto(f"{BASE}browse/exams/?interest=public-safety&window=open", wait_until="domcontentloaded", timeout=30_000)
    wait_for_guide(page)
    assert page.locator("#career-query").input_value() == ""
    assert page.locator("[data-career-facet='people:interest:public-safety'][aria-pressed='true']").count() == 1
    assert page.locator("[data-career-facet='people:window:open'][aria-pressed='true']").count() == 1
    assert page.locator("#staffing-active-filters").inner_text().strip()
    filtered = page.url
    page.reload(wait_until="domcontentloaded")
    wait_for_guide(page)
    assert page.url == filtered
    assert page.locator("[data-career-facet='people:interest:public-safety'][aria-pressed='true']").count() == 1

    # The route exposes the guide's empty copy and incremental growth.
    page.locator("#career-query").fill("no such civil-service exam exists")
    wait_for_locator(page.locator("#career-results .career-empty"), timeout=20_000, label="Exams empty state")
    assert "No exams" in page.locator("#career-results .career-empty").inner_text()
    page.goto(f"{BASE}browse/exams/", wait_until="domcontentloaded", timeout=30_000)
    wait_for_guide(page)
    more = page.locator("#career-more")
    expect(more).to_be_visible()
    before = page.locator("#career-results .career-card").count()
    more.click()
    page.wait_for_function("count => document.querySelectorAll('#career-results .career-card').length > count", arg=before)
    assert page.locator("#career-results .career-card").count() > before

    # Keyboard access remains on the shared guide controls.
    page.locator("#staffing-more-filters summary").focus()
    page.keyboard.press("Enter")
    assert page.locator("#staffing-more-filters").get_attribute("open") == ""
    page.keyboard.press("Escape")

    # The source Staffing route remains its original mixed guide + ledger frame.
    page.goto(f"{BASE}browse/staffing/", wait_until="domcontentloaded", timeout=30_000)
    wait_for_guide(page)
    assert page.locator("body").get_attribute("data-browse-route-alias") is None
    assert page.locator("#staffing-ledger").get_attribute("hidden") is None
    assert page.locator("#career-browser-heading").inner_text() == "Find an exam you can act on"


def main():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(permissions=["clipboard-read", "clipboard-write"])
        page = context.new_page()
        run(page)
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
