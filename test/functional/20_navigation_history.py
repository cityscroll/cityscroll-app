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

    # agency → notice: preserve the agency hash (not a global Contracts reset)
    agency = browser.new_page(viewport={"width": 1280, "height": 720})
    install_external_stubs(agency)
    agency.goto(
        BASE + "#agency/Consumer%20and%20Worker%20Protection",
        wait_until="domcontentloaded",
    )
    agency.wait_for_selector('#entityview [data-route-back]')
    # Keep the entity pane scrollable across async re-paint (showAgency rebuilds
    # #entityview and would remove an in-content fixture).
    agency.evaluate(
        """() => {
          const pane = document.querySelector('#tab-entity');
          if (pane) pane.style.minHeight = '3200px';
          document.body.style.minHeight = '3200px';
          const root = document.querySelector('#entityview') || document.body;
          const link = document.createElement('a');
          link.id = 'agency-notice-link';
          link.href = '#notice/navigation-fixture';
          link.textContent = 'Open notice';
          root.appendChild(link);
          window.scrollTo(0, 820);
        }"""
    )
    agency_y = agency.evaluate("scrollY")
    agency.locator("#agency-notice-link").evaluate("element => element.click()")
    agency.wait_for_selector('#noticeview [data-route-back="history"]')
    agency_back = agency.locator('#noticeview [data-route-back="history"]')
    step(
        agency_back.get_attribute("href")
        == "#agency/Consumer%20and%20Worker%20Protection",
        "agency → notice breadcrumb targets the agency profile",
        agency_back.get_attribute("href") or "missing href",
    )
    agency_back.evaluate("element => element.click()")
    agency.wait_for_function(
        "location.hash === '#agency/Consumer%20and%20Worker%20Protection'"
    )
    agency.wait_for_function("expected => Math.abs(scrollY - expected) <= 2", arg=agency_y)
    step(
        agency.evaluate("scrollY") == agency_y,
        "agency → notice restores agency scroll",
        str(agency.evaluate("({hash: location.hash, y: scrollY})")),
    )

    # notice → matter: chain stays on the notice, not the original Contracts list
    chain = browser.new_page(viewport={"width": 1280, "height": 720})
    install_external_stubs(chain)
    chain.goto(BASE + "#money?mode=award&q=bridge", wait_until="domcontentloaded")
    chain.wait_for_function(
        "document.querySelector('#tab-money').classList.contains('active')"
    )
    add_scroll_fixture(chain, "#tab-money", "#notice/navigation-fixture", "chain-notice-link")
    chain.locator("#chain-notice-link").evaluate("element => element.click()")
    chain.wait_for_selector('#noticeview [data-route-back="history"]')
    # showNotice rebuilds #noticeview on return — keep the notice pane tall.
    chain.evaluate(
        """() => {
          const pane = document.querySelector('#tab-notice');
          if (pane) pane.style.minHeight = '3000px';
          document.body.style.minHeight = '3000px';
          const root = document.querySelector('#noticeview') || document.body;
          const link = document.createElement('a');
          link.id = 'notice-matter-link';
          link.href = '#matter/84124P0003001';
          link.textContent = 'Open matter';
          root.appendChild(link);
          window.scrollTo(0, 640);
        }"""
    )
    notice_y = chain.evaluate("scrollY")
    chain.locator("#notice-matter-link").evaluate("element => element.click()")
    chain.wait_for_selector('#entityview [data-route-back="history"]')
    matter_back = chain.locator('#entityview [data-route-back="history"]')
    step(
        matter_back.get_attribute("href") == "#notice/navigation-fixture",
        "notice → matter breadcrumb targets the notice",
        matter_back.get_attribute("href") or "missing href",
    )
    matter_back.evaluate("element => element.click()")
    chain.wait_for_function("location.hash === '#notice/navigation-fixture'")
    chain.wait_for_function(
        "expected => Math.abs(scrollY - expected) <= 2", arg=notice_y, timeout=5000
    )
    step(
        chain.evaluate("scrollY") == notice_y,
        "notice → matter restores notice scroll",
        str(chain.evaluate("({hash: location.hash, y: scrollY})")),
    )

    # Filter rewrites must keep history.state so a later Back still has a place to restore
    preserve = browser.new_page(viewport={"width": 1280, "height": 720})
    install_external_stubs(preserve)
    preserve.goto(BASE + "#money?q=bridge", wait_until="domcontentloaded")
    preserve.wait_for_function(
        "document.querySelector('#tab-money').classList.contains('active')"
    )
    preserve.evaluate(
        """() => {
          history.replaceState(
            { cityscrollRoute: { entry: { hash: '#money?q=bridge', x: 0, y: 120 }, back: { hash: '#rules?q=sidewalk', x: 0, y: 50 } } },
            '',
            '#money?q=bridge'
          );
        }"""
    )
    preserve.fill("#kw", "tunnel")
    preserve.evaluate(
        """() => {
          const input = document.querySelector('#kw');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }"""
    )
    preserve.wait_for_timeout(300)
    state_after = preserve.evaluate("history.state")
    step(
        bool(
            state_after
            and state_after.get("cityscrollRoute")
            and state_after["cityscrollRoute"].get("back")
            and state_after["cityscrollRoute"]["back"].get("hash") == "#rules?q=sidewalk"
        ),
        "filter update preserves cityscrollRoute.back in history.state",
        str(state_after),
    )

    browser.close()


failures = tuple(name for ok, name in results if not ok)
print("SUMMARY:", "PASS" if not failures else f"FAIL ({len(failures)})")
sys.exit(1 if failures else 0)
