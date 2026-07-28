"""Characterization gate for the landing-identity layer (card 2) and its bypass (card 3).

A genuinely fresh browser (no hash, no `crol_landing_seen_v1` localStorage flag) sees the
identity layer instead of the tool on a bare "/" visit — but only once per browser, and
never at all if any existing permalink hash is present. The a11y/i18n/RTL pass over this
new route is test/functional/11_accessibility.py, 14_focus_visible.py, and 15_rtl.py (card
8), extended separately — this file characterizes render order and the bypass logic only.
"""

import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
HASH_KINDS = ["#money", "#land", "#people", "#notice/20260701001", "#vendor/acme", "#agency/hpd"]


def layer_state(page):
    return page.evaluate(
        """() => ({
          showLanding: document.documentElement.classList.contains('show-landing'),
          layerVisible: !!document.querySelector('#landing-identity')?.offsetParent,
          headerVisible: !!document.querySelector('header.masthead')?.offsetParent,
          mainVisible: !!document.querySelector('main#main')?.offsetParent,
          activeTab: document.querySelector('.tabbtn.active')?.dataset.tab || null
        })"""
    )


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()

    # A genuinely fresh visit (no hash, empty localStorage) renders the identity layer,
    # and hides the masthead/tool underneath it — before any tool markup would otherwise paint.
    context = browser.new_context()
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    page.goto(BASE, wait_until="domcontentloaded")
    state = layer_state(page)
    assert state["showLanding"] is True, state
    assert state["layerVisible"] is True, state
    assert state["headerVisible"] is False, state
    assert state["mainVisible"] is False, state
    print("OK fresh bare '/' visit renders the identity layer, tool hidden underneath")

    # The same browser (localStorage now carries the seen flag) does not show it a second time.
    page.goto(BASE, wait_until="domcontentloaded")
    state = layer_state(page)
    assert state["showLanding"] is False, state
    assert state["headerVisible"] is True, state
    print("OK second visit in the same browser skips the identity layer")
    context.close()

    # Every existing permalink hash — on a completely fresh browser — bypasses the layer too.
    for hash_kind in HASH_KINDS:
        context = browser.new_context()
        page = context.new_page()
        page.route("https://**", lambda route: route.abort())
        page.goto(BASE + hash_kind, wait_until="domcontentloaded")
        state = layer_state(page)
        assert state["showLanding"] is False, (hash_kind, state)
        assert state["headerVisible"] is True, (hash_kind, state)
        context.close()
    print(f"OK all {len(HASH_KINDS)} permalink hash kinds bypass the identity layer on a fresh browser")

    # The Contracts CTA dismisses the layer and lands on the Contracts (money) lens.
    context = browser.new_context()
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("#landingCtaContracts").click()
    state = layer_state(page)
    assert state["showLanding"] is False, state
    assert state["mainVisible"] is True, state
    assert state["activeTab"] == "money", state
    assert page.evaluate("location.hash") == "#money", page.evaluate("location.hash")
    context.close()
    print("OK the Contracts CTA dismisses the layer onto the Contracts lens")

    # The Zoning CTA dismisses the layer and lands on the Zoning (land) lens.
    context = browser.new_context()
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("#landingCtaZoning").click()
    state = layer_state(page)
    assert state["showLanding"] is False, state
    assert state["activeTab"] == "land", state
    assert page.evaluate("location.hash").startswith("#land"), page.evaluate("location.hash")
    context.close()
    print("OK the Zoning CTA dismisses the layer onto the Zoning lens")

    # The muted "more" link dismisses the layer and opens the secondary disclosure.
    context = browser.new_context()
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("#landingMore").click()
    state = layer_state(page)
    assert state["showLanding"] is False, state
    assert page.locator("#more-tabs-toggle").get_attribute("aria-expanded") == "true", state
    assert not page.locator("#secondary-tabs").get_attribute("hidden")
    context.close()
    print("OK the 'more' link dismisses the layer and opens the secondary disclosure")

    # Asking a question from the identity layer dismisses it and hands the query to the tool.
    context = browser.new_context()
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("#landingAsk").fill("rezonings near me")
    page.locator("#landingAskForm button[type=submit]").click()
    state = layer_state(page)
    assert state["showLanding"] is False, state
    assert state["activeTab"] == "money", state
    assert page.locator("#nlq").input_value() == "rezonings near me"
    context.close()
    print("OK asking from the identity layer dismisses it and hands the query to the tool")

    browser.close()

print("✅ landing-identity layer renders once on a fresh bare '/' visit and every bypass path holds")
