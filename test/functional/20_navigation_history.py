"""Deterministic browser coverage for context-aware item-route Back navigation.

Run with the static site served from ``site/`` using the repository's local test server.
External data requests are stubbed because this test exercises navigation state, not data joins.
"""
import os
import sys

from playwright.sync_api import sync_playwright


DEFAULT_TEST_HOST = "localhost"
DEFAULT_TEST_PORT = 8000
BASE = os.environ.get(
    "CROL_BASE", f"http://{DEFAULT_TEST_HOST}:{DEFAULT_TEST_PORT}/"
)
results = list()


def step(ok, name, detail=""):
    results.append((ok, name))
    print(f"{'OK' if ok else 'FAIL'} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def stub_external(route):
    url = route.request.url
    if "api.cityscroll.org/rules" in url:
        route.fulfill(status=200, content_type="application/json", body='{"rules":[]}')
    elif "api.cityscroll.org" in url:
        route.fulfill(status=200, content_type="application/json", body="{}")
    else:
        route.fulfill(status=200, content_type="application/json", body="[]")


def install_external_stubs(page):
    page.route("https://data.cityofnewyork.us/**", stub_external)
    page.route("https://api.cityscroll.org/**", stub_external)


def add_scroll_fixture(page, pane, link_hash, link_id):
    page.evaluate(
        """({pane, linkHash, linkId}) => {
          const wrap = document.querySelector(pane + ' .wrap');
          const fixture = document.createElement('div');
          fixture.id = 'history-scroll-fixture';
          fixture.style.height = '2600px';
          fixture.innerHTML = `<a id="${linkId}" href="${linkHash}">Open detail</a>`;
          wrap.appendChild(fixture);
          window.scrollTo(0, 900);
        }""",
        {"pane": pane, "linkHash": link_hash, "linkId": link_id},
    )


def assert_return(page, expected_hash, expected_input, input_selector, expected_y):
    page.locator('[data-route-back="history"]').evaluate("element => element.click()")
    page.wait_for_function("expected => location.hash === expected", arg=expected_hash)
    page.wait_for_function(
        "([selector, value]) => document.querySelector(selector)?.value === value",
        arg=[input_selector, expected_input],
    )
    page.wait_for_function("expected => Math.abs(scrollY - expected) <= 2", arg=expected_y)
    return page.evaluate("({hash: location.hash, y: scrollY})")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()

    rules = browser.new_page(viewport={"width": 1280, "height": 720})
    install_external_stubs(rules)
    rules.goto(BASE + "#rules?q=sidewalk", wait_until="domcontentloaded")
    rules.wait_for_function("document.querySelector('#tab-rules').classList.contains('active')")
    add_scroll_fixture(
        rules,
        "#tab-rules",
        "#agency/Consumer%20and%20Worker%20Protection",
        "rules-agency-link",
    )
    source_y = rules.evaluate("scrollY")
    rules.locator("#rules-agency-link").evaluate("element => element.click()")
    rules.wait_for_selector('#entityview [data-route-back="history"]')
    back = rules.locator('#entityview [data-route-back="history"]')
    step(
        back.get_attribute("href") == "#rules?q=sidewalk",
        "rules → agency breadcrumb targets the exact prior filter",
        back.get_attribute("href") or "missing href",
    )
    restored = assert_return(rules, "#rules?q=sidewalk", "sidewalk", "#ruleskw", source_y)
    step(restored["y"] == source_y, "rules → agency restores scroll", str(restored))

    money = browser.new_page(viewport={"width": 1280, "height": 720})
    install_external_stubs(money)
    money.goto(BASE + "#money?mode=award&q=bridge", wait_until="domcontentloaded")
    money.wait_for_function("document.querySelector('#tab-money').classList.contains('active')")
    add_scroll_fixture(money, "#tab-money", "#notice/navigation-fixture", "money-notice-link")
    source_y = money.evaluate("scrollY")
    money.locator("#money-notice-link").evaluate("element => element.click()")
    money.wait_for_selector('#noticeview [data-route-back="history"]')
    restored = assert_return(money, "#money?mode=award&q=bridge", "bridge", "#kw", source_y)
    step(
        money.locator("#mode").input_value() == "award" and restored["y"] == source_y,
        "filtered Contracts → notice restores filters and scroll",
        str(restored),
    )

    cold = browser.new_page(viewport={"width": 1280, "height": 720})
    install_external_stubs(cold)
    cold.goto(BASE + "#agency/Cold%20Deep%20Link", wait_until="domcontentloaded")
    cold.wait_for_selector('#entityview [data-route-back="fallback"]')
    fallback = cold.locator('#entityview [data-route-back="fallback"]')
    step(
        fallback.get_attribute("href") == "#money",
        "cold agency deep link exposes a safe Contracts fallback",
        fallback.get_attribute("href") or "missing href",
    )
    fallback.evaluate("element => element.click()")
    cold.wait_for_function("location.hash === '#money'")
    step(cold.url.startswith(BASE), "cold fallback stays inside CityScroll", cold.url)

    browser.close()


failures = tuple(name for ok, name in results if not ok)
print("SUMMARY:", "PASS" if not failures else f"FAIL ({len(failures)})")
sys.exit(1 if failures else 0)
