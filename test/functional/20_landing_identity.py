"""Characterization gate for the landing-identity layer and its bypass routes.

A genuinely fresh browser (no hash, no `crol_landing_seen_v1` localStorage flag) sees the
identity layer instead of the tool on a bare "/" visit — but only once per browser, and
never at all if any existing permalink hash is present. The a11y/i18n/RTL pass over this
new route is test/functional/11_accessibility.py, 14_focus_visible.py, and 15_rtl.py,
extended separately — this file characterizes render order and the bypass logic only.
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
    routes = page.locator(".landing-cta")
    assert routes.count() == 3, "landing must offer three equally styled routes"
    assert routes.evaluate_all(
        """els => new Set(els.map(el => [
          getComputedStyle(el).backgroundColor,
          getComputedStyle(el).borderColor,
          getComputedStyle(el).color
        ].join('|'))).size"""
    ) == 1, "landing routes must have equal visual weight"
    print("OK fresh bare '/' visit renders the identity layer with three equal routes")

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
    assert page.locator(".nlbox #nlq").count() == 1, "the ask row must be back in the Contracts nlbox"
    context.close()
    print("OK the Contracts CTA dismisses the layer onto the Contracts lens, restoring the ask row")

    # The Staffing CTA dismisses the layer and lands on the Staffing (people) lens.
    context = browser.new_context()
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("#landingCtaStaffing").click()
    state = layer_state(page)
    assert state["showLanding"] is False, state
    assert state["activeTab"] == "people", state
    assert page.evaluate("location.hash") == "#people", page.evaluate("location.hash")
    assert page.locator("#city-careers-heading").is_visible()
    assert page.locator("#tab-people a[href='https://cityjobs.nyc.gov/jobs']").count() == 1
    assert page.locator("#tab-people a[href*='exam-schedules-open-competitive-exams']").count() == 1
    context.close()
    print("OK the Staffing CTA opens role data plus official jobs and exam routes")

    # The browse route reveals the full, flat navigation without privileging a subset.
    context = browser.new_context()
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("#landingCtaBrowse").click()
    state = layer_state(page)
    assert state["showLanding"] is False, state
    assert state["mainVisible"] is True, state
    assert page.locator(".lens-nav > .tabbtn").count() == 7
    assert page.locator(".lens-nav .tabbtn[data-tab='people']").is_visible()
    assert page.locator(".lens-nav .tabbtn[data-tab='alerts']").is_visible()
    context.close()
    print("OK the browse route reveals all seven co-equal tool routes")

    # Asking a question from the identity layer dismisses it and hands the query to the tool.
    context = browser.new_context()
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    page.goto(BASE, wait_until="domcontentloaded")
    assert page.locator("#landingAskSlot #nlq").count() == 1, "the tool's own #nlq should relocate into the layer"
    page.locator("#landingAskSlot #nlq").fill("technology contracts")
    page.locator("#landingAskSlot #nlgo").click()
    state = layer_state(page)
    assert state["showLanding"] is False, state
    assert state["activeTab"] == "money", state
    assert page.locator("#nlq").input_value() == "technology contracts"
    assert page.locator("#landingAskSlot #nlq").count() == 0, "the ask row must move back into the tool on dismiss"
    assert page.locator(".nlbox #nlq").count() == 1, "the ask row must be back in the Contracts nlbox"
    context.close()
    print("OK asking from the identity layer dismisses it and hands the query to the tool, restoring the ask row")

    browser.close()

print("✅ landing-identity layer renders once on a fresh bare '/' visit and every bypass path holds")
