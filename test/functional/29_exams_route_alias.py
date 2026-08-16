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


def assert_active_civic_object(page, href):
    active = page.locator(".browse-child-tabs .tabbtn.active")
    assert active.count() == 1
    assert active.get_attribute("href") == href
    assert active.get_attribute("aria-controls") == "tab-people"
    assert page.locator("#tab-people").get_attribute("aria-labelledby") == active.get_attribute("id")


def assert_shared_exam_card_grammar(page):
    cards = page.locator("#career-results .career-card")
    assert cards.count() >= 3

    # Exams must inherit the Staffing renderer rather than assembling an
    # alias-specific card. Each visible card opens and copies one canonical
    # CityScroll exam record and marks its official source as off-site.
    for index in range(3):
        card = cards.nth(index)
        title = card.locator("a.ui-object-card-title")
        copy = card.locator("button.ui-object-card-copy")
        source = card.locator("a.career-official-handoff")
        expect(title).to_be_visible()
        expect(copy).to_be_visible()
        expect(source).to_be_visible()
        assert title.locator('[aria-hidden="true"]').inner_text() == "◆"
        assert title.get_attribute("href").startswith("/exams/")
        assert copy.inner_text().strip() == "Copy link"
        expected_copy = page.evaluate(
            "href => new URL(href, location.origin).href",
            title.get_attribute("href"),
        )
        assert copy.get_attribute("data-object-card-copy") == expected_copy
        assert "↗" in source.inner_text()
        assert page.evaluate(
            "href => new URL(href, location.origin).origin !== location.origin",
            source.get_attribute("href"),
        )

    # Apply is kinetic only while its filing window is open. The shared action
    # style must also retain WCAG-AA text contrast; this guards the previously
    # reported black-on-blue button regression.
    open_card = page.locator("#career-results .career-card[data-status='open']").first
    expect(open_card).to_be_visible()
    apply = open_card.locator(".ui-object-card-action-rail a.ui-external-action.primary")
    expect(apply).to_be_visible()
    assert "↗" in apply.inner_text()
    contrast = apply.evaluate(
        """element => {
          const parse = value => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
          const luminance = value => {
            const rgb = parse(value).map(channel => {
              const normalized = channel / 255;
              return normalized <= 0.04045
                ? normalized / 12.92
                : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
          };
          const style = getComputedStyle(element);
          const foreground = luminance(style.color);
          const background = luminance(style.backgroundColor);
          return (Math.max(foreground, background) + 0.05)
            / (Math.min(foreground, background) + 0.05);
        }"""
    )
    assert contrast >= 4.5, f"Apply action contrast must be WCAG AA, got {contrast:.2f}:1"

    upcoming = page.locator("#career-results .career-card[data-status='upcoming']").first
    expect(upcoming).to_be_visible()
    assert upcoming.locator(".ui-object-card-action-rail").count() == 0


def run(page):
    install_routes(page)

    # Exams owns a document route even though its interaction contract is
    # implemented by the Staffing guide. The Browse nav must perform a native
    # navigation instead of exposing the retired inline #tab-exams splash.
    page.goto(f"{BASE}browse/contracts/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("typeof window.showTab === 'function'")
    # Regression: the Exams nav item must keep its own route and highlight;
    # resolving the shared view through Staffing crossed the two lens states.
    page.locator(".browse-child-tabs [href='/browse/exams/']").click()
    page.wait_for_url(f"{BASE}browse/exams/", timeout=30_000)
    wait_for_guide(page)
    assert page.url.rstrip("/").endswith("/browse/exams")
    assert_active_civic_object(page, "/browse/exams/")
    expect(page.locator("#tab-exams")).to_be_hidden()
    assert page.locator("#tab-people.active").count() == 1
    assert page.locator("#career-guide").is_visible()
    expect(page.locator("#staffing-ledger")).to_be_hidden()
    assert page.locator("#staffing-ledger").get_attribute("hidden") == ""
    assert page.locator("#career-browser-heading").inner_text() == "Civil-service exams"
    assert page.locator("#career-guide .career-kicker").first.text_content().strip() == "Exams"
    assert page.locator("#career-result-count").inner_text().strip()
    assert page.locator("#career-source").inner_text().strip()
    assert_shared_exam_card_grammar(page)

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

    # Leaving the alias through its shared parent opens Staffing rather than
    # trapping the click on the Exams URL.
    page.locator(".browse-child-tabs [href='/browse/people/']").click()
    page.wait_for_url(f"{BASE}browse/staffing/", timeout=30_000)
    wait_for_guide(page)
    assert page.locator("body").get_attribute("data-browse-route-alias") is None
    assert_active_civic_object(page, "/browse/people/")
    assert page.locator("#staffing-ledger").get_attribute("hidden") is None
    assert page.locator("#career-browser-heading").inner_text() == "Find an exam you can act on"
    assert_shared_exam_card_grammar(page)


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
