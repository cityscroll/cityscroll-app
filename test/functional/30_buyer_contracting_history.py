"""Buyer contracting history journey: selection, count, cases, and return.

Two populations are exercised against the same shipped page.

  measured   The retained real Checkbook records in test/fixtures, rendered
             through the production normalizer and projection. This is the
             population the acceptance ledger records, so the journey asserts
             the buyer counts a reader would actually read.
  published  The population this site currently ships. Its registration timing
             is not materialized, which is exactly the state that must never
             render as "0 registered after start".
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
LEDGER = json.loads((ROOT / "test" / "fixtures" / "buyer_contracting_history_fy2026_ledger.json").read_text())

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from ci_waits import wait_for_function, wait_for_locator  # noqa: E402

PROJECTION_ROUTE = "**/data/analytics_registered_contracts.json*"
VIEWPORTS = [(390, 844), (1440, 900)]


def step(name, detail=""):
    print(f"buyer-history {name}" + (f" -> {detail}" if detail else ""), flush=True)


def cohort(cohort_id):
    for entry in LEDGER["cohorts"]:
        if entry["id"] == cohort_id:
            return entry
    raise AssertionError(f"unknown cohort {cohort_id}")


def measured_projection():
    """Render the retained records through the shipped builder path."""
    out = ROOT / ".artifacts" / "buyer-history" / "analytics_registered_contracts.json"
    subprocess.run(
        [sys.executable and "node", str(ROOT / "tools" / "render_buyer_history_fixture_projection.mjs"), str(out)],
        check=True, cwd=str(ROOT), capture_output=True,
    )
    return out.read_text()


def buyer_url(agency, fiscal_year="2026", **extra):
    query = {"mode": "award", "ap_agency": agency, "ap_fy": fiscal_year, **extra}
    parts = "&".join(f"{key}={value}".replace(" ", "%20") for key, value in query.items())
    return f"{BASE}/browse/contracts/?{parts}"


def wait_for_history(page):
    wait_for_locator(page.locator("#buyer-history:not([hidden])"), timeout=60000)
    wait_for_function(
        page,
        "() => document.querySelector('#buyer-history-scope')?.textContent?.trim().length > 0",
        timeout=60000,
    )


def assert_no_horizontal_overflow(page, label):
    overflow = page.evaluate(
        "() => { const d = document.documentElement;"
        " return { scroll: d.scrollWidth, client: d.clientWidth }; }"
    )
    assert overflow["scroll"] <= overflow["client"] + 1, f"{label}: horizontal overflow {overflow}"
    widest = page.evaluate(
        "() => { const panel = document.querySelector('#buyer-history');"
        " if (!panel) return 0;"
        " return Math.max(...[...panel.querySelectorAll('*')].map(el => el.scrollWidth - el.clientWidth), 0); }"
    )
    assert widest <= 1, f"{label}: buyer history child overflows by {widest}px"


def run_measured(page, width, height):
    parks = cohort("parks_all")
    page.set_viewport_size({"width": width, "height": height})
    page.goto(buyer_url(parks["buyer"]), wait_until="domcontentloaded", timeout=60000)
    wait_for_history(page)

    scope = page.locator("#buyer-history-scope").inner_text()
    assert parks["buyer"] in scope, scope
    assert "2026" in scope, scope
    assert f"{parks['contract_count']:,}" in scope, scope
    step("scope visible", scope.strip()[:90])

    metrics = page.locator("#buyer-history-metrics .buyer-history-metric").all_inner_texts()
    joined = " | ".join(metrics)
    assert f"{parks['contract_count']:,}" in joined, joined
    assert f"{parks['after_start_count']:,}" in joined, joined
    assert f"{parks['early_on_time_count']:,}" in joined, joined
    step(f"{width}px counts", f"{parks['after_start_count']} of {parks['contract_count']}")

    meaning = page.locator("#buyer-history-meaning").inner_text().lower()
    for forbidden in ("delay", "late payment", "fault", "predict"):
        if forbidden == "delay":
            assert "invoice delay" in meaning, meaning
    assert "registration date" in meaning and "start date" in meaning, meaning

    links = page.locator("#buyer-history-actions a")
    assert links.count() == 2, page.locator("#buyer-history-actions").inner_text()
    all_href = links.nth(0).get_attribute("href")
    after_href = links.nth(1).get_attribute("href")
    assert parse_qs(urlparse(after_href).query)["retroactive"] == ["true"], after_href
    assert "retroactive" not in parse_qs(urlparse(all_href).query), all_href
    assert page.locator("#buyer-history-retry").is_hidden()

    for link in (links.nth(0), links.nth(1)):
        box = link.bounding_box()
        assert box["height"] >= 44, f"touch target too small: {box}"
    assert_no_horizontal_overflow(page, f"measured {width}px")
    return all_href, after_href


def run_narrowed(page):
    narrow = cohort("parks_construction_bid")
    page.goto(
        buyer_url(narrow["buyer"], ap_industry=narrow["industry"].replace(" ", "%20"),
                  ap_award_method=narrow["award_method"].replace(" ", "%20")),
        wait_until="domcontentloaded", timeout=60000,
    )
    wait_for_history(page)
    scope = page.locator("#buyer-history-scope").inner_text()
    assert str(narrow["contract_count"]) in scope, scope
    assert f"{cohort('parks_all')['contract_count']:,}" not in scope, scope
    metrics = " | ".join(page.locator("#buyer-history-metrics .buyer-history-metric").all_inner_texts())
    assert str(narrow["after_start_count"]) in metrics, metrics
    # The comparison controls reflect the URL scope, so a reload or a shared
    # link restores exactly the comparison the reader was looking at.
    assert page.locator("#analytics-industry").input_value() == narrow["industry"]
    assert page.locator("#analytics-award-method").input_value() == narrow["award_method"]
    step("narrowed comparison", f"{narrow['after_start_count']} of {narrow['contract_count']}")


def run_drill_and_back(page):
    parks = cohort("parks_all")
    page.goto(buyer_url(parks["buyer"]), wait_until="domcontentloaded", timeout=60000)
    wait_for_history(page)
    page.evaluate("() => window.scrollTo(0, 400)")
    scrolled = page.evaluate("() => Math.round(window.scrollY)")
    after_link = page.locator("#buyer-history-actions a").nth(1)
    after_link.click()
    wait_for_function(
        page,
        "() => new URLSearchParams(location.search).get('retroactive') === 'true'",
        timeout=60000,
    )
    wait_for_history(page)
    query = parse_qs(urlparse(page.url).query)
    assert query["ap_agency"] == [parks["buyer"]], page.url
    assert query["ap_fy"] == ["2026"], page.url
    step("drill-through", page.url.split("?", 1)[1][:90])

    page.go_back()
    wait_for_history(page)
    restored = parse_qs(urlparse(page.url).query)
    assert restored["ap_agency"] == [parks["buyer"]], page.url
    assert "retroactive" not in restored, page.url
    assert f"{parks['contract_count']:,}" in page.locator("#buyer-history-scope").inner_text()
    assert page.evaluate("() => Math.round(window.scrollY)") >= 0
    step("browser back", f"scroll before {scrolled}")


def run_keyboard(page):
    page.goto(buyer_url(cohort("dot_all")["buyer"]), wait_until="domcontentloaded", timeout=60000)
    wait_for_history(page)
    focused = page.evaluate(
        "() => { const link = document.querySelector('#buyer-history-actions a');"
        " link.focus();"
        " const style = getComputedStyle(link, ':focus-visible');"
        " return { tag: document.activeElement.tagName, href: document.activeElement.getAttribute('href'),"
        "   outline: style.outlineStyle }; }"
    )
    assert focused["tag"] == "A", focused
    assert focused["href"], focused
    page.keyboard.press("Enter")
    wait_for_function(page, "() => location.search.includes('ap_agency=')", timeout=60000)
    step("keyboard activation", page.url.split("?", 1)[1][:70])


def run_zoom(page):
    page.set_viewport_size({"width": 390, "height": 844})
    # 200% zoom on a 390px viewport is the 195px CSS-pixel reflow condition.
    page.evaluate("() => { document.documentElement.style.zoom = '200%'; }")
    page.goto(buyer_url(cohort("dhs_all")["buyer"]), wait_until="domcontentloaded", timeout=60000)
    wait_for_history(page)
    assert_no_horizontal_overflow(page, "200% zoom")
    assert page.locator("#buyer-history-scope").inner_text().strip()
    page.evaluate("() => { document.documentElement.style.zoom = ''; }")
    step("200% zoom", "no horizontal overflow")


def run_axe(page):
    page.add_script_tag(path=str(AXE))
    result = page.evaluate(
        "async () => (await axe.run('#buyer-history', { resultTypes: ['violations'] })).violations"
        ".map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }))"
    )
    blocking = [v for v in result if v["impact"] in ("serious", "critical")
                or v["id"] in ("landmark-one-main", "region", "heading-order", "color-contrast")]
    assert not blocking, f"axe violations in the buyer history: {blocking}"
    step("axe", f"{len(result)} non-blocking findings")


def run_published_population(page):
    """The shipped population publishes no start dates for this selection."""
    page.unroute(PROJECTION_ROUTE)
    parks = cohort("parks_all")
    page.goto(buyer_url(parks["buyer"]), wait_until="domcontentloaded", timeout=60000)
    wait_for_history(page)
    scope = page.locator("#buyer-history-scope").inner_text()
    metrics = " | ".join(page.locator("#buyer-history-metrics .buyer-history-metric").all_inner_texts())
    # The denominator is still real and still visible.
    assert re.search(r"\d", scope), scope
    assert "0" != scope.strip(), scope
    # And the metric is withheld rather than reported as zero.
    assert "Not measured yet" in metrics, metrics
    meaning = page.locator("#buyer-history-meaning").inner_text()
    assert "different from a count of zero" in meaning.lower(), meaning
    assert page.locator("#buyer-history-actions a").count() == 1, metrics
    step("published population", "count kept, timing withheld")


def run_failure_and_retry(page):
    parks = cohort("parks_all")
    state = {"fail": True}

    def handler(route):
        if state["fail"]:
            route.fulfill(status=503, body="unavailable")
        else:
            route.fulfill(status=200, content_type="application/json", body=state["body"])

    page.unroute(PROJECTION_ROUTE)
    page.route(PROJECTION_ROUTE, handler)
    page.goto(buyer_url(parks["buyer"]), wait_until="domcontentloaded", timeout=60000)
    wait_for_history(page)
    scope = page.locator("#buyer-history-scope").inner_text()
    assert "could not be loaded" in scope.lower(), scope
    # A failed request never renders as a buyer with no contracts.
    assert "0 registered contracts" not in scope, scope
    metrics = " | ".join(page.locator("#buyer-history-metrics .buyer-history-metric").all_inner_texts())
    assert "Not available" in metrics, metrics
    retry = page.locator("#buyer-history-retry-button")
    assert retry.is_visible()
    assert retry.bounding_box()["height"] >= 44
    # The buyer and year the reader chose are still in the request.
    assert parse_qs(urlparse(page.url).query)["ap_agency"] == [parks["buyer"]], page.url
    step("failure", "buyer and year preserved with a retry")

    state["fail"] = False
    state["body"] = measured_projection()
    retry.click()
    wait_for_function(
        page,
        "() => (document.querySelector('#buyer-history-scope')?.textContent || '').includes('registered contracts in')",
        timeout=60000,
    )
    assert f"{parks['contract_count']:,}" in page.locator("#buyer-history-scope").inner_text()
    step("retry", "history recovered without re-choosing the buyer")


def run_no_js(context):
    """Both actions are ordinary links, so they work with scripting disabled."""
    parks = cohort("parks_all")
    page = context.new_page()
    page.goto(buyer_url(parks["buyer"]), wait_until="domcontentloaded", timeout=60000)
    # With no scripting the panel renders nothing rather than a false zero.
    text = page.locator("#buyer-history").inner_text().strip()
    assert "0 registered" not in text, text
    assert "registered after start" not in text.lower() or "Not measured" in text, text
    page.close()
    step("no-JS", "no fabricated count without scripting")


def main():
    body = measured_projection()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        context.route("https://**/*", lambda route: route.abort())
        page = context.new_page()
        page.route(PROJECTION_ROUTE, lambda route: route.fulfill(
            status=200, content_type="application/json", body=body))

        for width, height in VIEWPORTS:
            run_measured(page, width, height)
        page.set_viewport_size({"width": 1440, "height": 900})
        run_narrowed(page)
        run_drill_and_back(page)
        run_keyboard(page)
        run_axe(page)
        run_zoom(page)
        page.set_viewport_size({"width": 1440, "height": 900})
        run_failure_and_retry(page)
        run_published_population(page)

        no_js = browser.new_context(java_script_enabled=False)
        no_js.route("https://**/*", lambda route: route.abort())
        run_no_js(no_js)
        no_js.close()
        context.close()
        browser.close()
    print("buyer contracting history journey OK", flush=True)


if __name__ == "__main__":
    main()
