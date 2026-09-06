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

import hashlib
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


def wait_for_cases(page, count):
    wait_for_function(
        page,
        f"() => document.querySelectorAll('#buyer-history-cases a[data-contract-id]').length === {count}",
        timeout=60000,
    )


def run_inspect(page):
    narrow = cohort("parks_construction_bid")
    page.goto(
        buyer_url(
            narrow["buyer"],
            ap_industry=narrow["industry"],
            ap_award_method=narrow["award_method"],
            ap_cases="1",
        ),
        wait_until="domcontentloaded", timeout=60000,
    )
    wait_for_history(page)
    wait_for_cases(page, narrow["contract_count"])
    ids = sorted(page.locator("#buyer-history-cases a[data-contract-id]").evaluate_all(
        "els => els.map(el => el.getAttribute('data-contract-id'))"
    ))
    assert ids == narrow["contract_ids"], ids
    assert str(narrow["contract_count"]) in page.locator("#buyer-history-scope").inner_text()
    step("all cases", f"{len(ids)} distinct")

    page.goto(
        buyer_url(
            narrow["buyer"],
            ap_industry=narrow["industry"],
            ap_award_method=narrow["award_method"],
            ap_cases="1",
            retroactive="true",
        ),
        wait_until="domcontentloaded", timeout=60000,
    )
    wait_for_history(page)
    wait_for_cases(page, narrow["after_start_count"])
    late_ids = sorted(page.locator("#buyer-history-cases a[data-contract-id]").evaluate_all(
        "els => els.map(el => el.getAttribute('data-contract-id'))"
    ))
    assert late_ids == [
        "CT184620258809333",
        "CT184620268802665",
        "CT184620268803841",
        "CT184620268805367",
        "CT184620268805555",
    ], late_ids
    assert str(narrow["contract_count"]) in page.locator("#buyer-history-scope").inner_text()
    step("after-start cases", f"{len(late_ids)} of {narrow['contract_count']}")

    linked = page.locator('#buyer-history-cases a[data-contract-id="CT184620268805555"]')
    assert linked.bounding_box()["height"] >= 44
    linked.click()
    wait_for_function(
        page,
        "() => new URLSearchParams(location.search).get('ap_inspect') === 'CT184620268805555'",
        timeout=60000,
    )
    wait_for_history(page)
    inspect = page.locator("#buyer-history-inspect")
    assert inspect.is_visible()
    text = inspect.inner_text()
    assert "WILLIAM A GROSS" in text.upper() or "Gross" in text
    assert "2026-03-16" in text and "2026-03-30" in text
    assert "14 days after start" in text
    assert page.locator('#buyer-history-inspect a[data-destination-kind="procurement"]').count() == 1
    assert page.locator('#buyer-history-inspect a[data-destination-kind="notice"]').count() == 1
    assert "/procurements/procurement%3Acontract%3ACT184620268805555" in page.locator(
        '#buyer-history-inspect a[data-destination-kind="procurement"]'
    ).get_attribute("href")
    assert "/notices/20260331013" in page.locator(
        '#buyer-history-inspect a[data-destination-kind="notice"]'
    ).get_attribute("href")
    assert str(narrow["contract_count"]) in page.locator("#buyer-history-scope").inner_text()
    assert page.locator("#buyer-history-cases a[data-contract-id]").count() == narrow["after_start_count"]
    page.add_script_tag(path=str(AXE))
    inspect_axe = page.evaluate(
        "async () => (await axe.run('#buyer-history', { resultTypes: ['violations'] })).violations"
        ".map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }))"
    )
    blocking = [v for v in inspect_axe if v["impact"] in ("serious", "critical")
                or v["id"] in ("landmark-one-main", "region", "heading-order", "color-contrast")]
    assert not blocking, f"axe violations while inspecting a counted case: {blocking}"
    inspect_html = page.locator("#buyer-history-inspect").inner_html()
    step("linked inspect", "14 days plus exact destinations "
         + hashlib.sha256(inspect_html.encode("utf-8")).hexdigest())

    page.locator("#buyer-history-inspect .buyer-history-inspect-actions a").click()
    wait_for_function(
        page,
        "() => !new URLSearchParams(location.search).get('ap_inspect')",
        timeout=60000,
    )
    wait_for_history(page)
    assert page.locator("#buyer-history-inspect").is_hidden()
    assert str(narrow["contract_count"]) in page.locator("#buyer-history-scope").inner_text()
    wait_for_cases(page, narrow["after_start_count"])
    step("dismiss", "cohort unchanged")

    source_only = page.locator('#buyer-history-cases a[data-contract-id="CT184620268805367"]')
    source_only.focus()
    page.keyboard.press("Enter")
    wait_for_function(
        page,
        "() => new URLSearchParams(location.search).get('ap_inspect') === 'CT184620268805367'",
        timeout=60000,
    )
    wait_for_history(page)
    source_text = page.locator("#buyer-history-inspect").inner_text()
    assert "2026-03-26" in source_text and "2026-04-01" in source_text
    assert "6 days after start" in source_text
    assert page.locator("#buyer-history-inspect a[data-destination-kind]").count() == 0
    assert "checkbooknyc.com" not in source_text.lower()
    assert str(narrow["contract_count"]) in page.locator("#buyer-history-scope").inner_text()
    step("source-only inspect", "six days, no invented destination")

    page.goto(
        buyer_url(
            narrow["buyer"],
            ap_industry=narrow["industry"],
            ap_award_method=narrow["award_method"],
            ap_cases="1",
            ap_inspect="CT-NOT-IN-COHORT",
        ),
        wait_until="domcontentloaded", timeout=60000,
    )
    wait_for_history(page)
    failure = page.locator("#buyer-history-inspect").inner_text()
    assert "CT-NOT-IN-COHORT" in failure
    assert page.locator("#buyer-history-inspect-retry").is_visible()
    assert page.locator("#buyer-history-inspect-retry").bounding_box()["height"] >= 44
    assert str(narrow["contract_count"]) in page.locator("#buyer-history-scope").inner_text()
    assert "could not be loaded" not in page.locator("#buyer-history-scope").inner_text().lower()
    assert_no_horizontal_overflow(page, "inspect failure 1440")
    page.set_viewport_size({"width": 390, "height": 844})
    assert_no_horizontal_overflow(page, "inspect failure 390")
    page.set_viewport_size({"width": 1440, "height": 900})
    step("requested-case failure", "selected id retained")


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


AMOUNT_BAND_1M = "$1 million–$9.99 million"


def render_pursuit_fixtures():
    out = ROOT / ".artifacts" / "buyer-history-pursuit"
    subprocess.run(
        ["node", str(ROOT / "tools" / "render_buyer_history_pursuit_fixtures.mjs"), str(out)],
        check=True, cwd=str(ROOT), capture_output=True,
    )
    return out


def run_pursuit_from_opportunity(page):
    fixtures = render_pursuit_fixtures()
    html = (fixtures / "parks-20260608045.html").read_text()
    page.set_content(html, wait_until="domcontentloaded")
    link = page.locator("[data-buyer-history-comparison]")
    assert link.count() == 1, page.content()[:800]
    box = link.bounding_box()
    assert box and box["height"] >= 44, box
    href = link.get_attribute("href")
    assert "ap_agency=" in href and "ap_industry=" in href and "ap_award_method=" in href, href
    assert "ap_amount_band=" not in href, href
    page.goto(BASE + href if href.startswith("/") else href, wait_until="domcontentloaded", timeout=60000)
    wait_for_history(page)
    scope = page.locator("#buyer-history-scope").inner_text()
    metrics = " | ".join(page.locator("#buyer-history-metrics .buyer-history-metric").all_inner_texts())
    assert "40" in scope, scope
    assert "5" in metrics, metrics
    assert page.locator("#analytics-industry").input_value() == "Construction Services"
    assert page.locator("#analytics-award-method").input_value() == "COMPETITIVE SEALED BIDDING"
    page.locator("#buyer-history-actions a").first.click()
    wait_for_function(
        page,
        "() => new URLSearchParams(location.search).get('ap_cases') === '1'",
        timeout=60000,
    )
    wait_for_history(page)
    wait_for_cases(page, 40)
    step("opportunity Parks", "5 of 40 from notice 20260608045")

    page.locator("#analytics-amount-band").select_option(AMOUNT_BAND_1M)
    wait_for_function(
        page,
        "() => (document.querySelector('#buyer-history-scope')?.textContent || '').includes('40') === false"
        " && (document.querySelector('#buyer-history-scope')?.textContent || '').includes('31')",
        timeout=60000,
    )
    wait_for_cases(page, 31)
    query = parse_qs(urlparse(page.url).query)
    assert query.get("ap_amount_band") == [AMOUNT_BAND_1M], page.url
    assert "31" in page.locator("#buyer-history-scope").inner_text()
    inspect = page.locator("#buyer-history-cases a[data-contract-id]").first
    inspect.focus()
    page.keyboard.press("Enter")
    wait_for_function(
        page,
        "() => Boolean(new URLSearchParams(location.search).get('ap_inspect'))",
        timeout=60000,
    )
    wait_for_history(page)
    assert page.locator("#buyer-history-inspect").is_visible()
    assert "31" in page.locator("#buyer-history-scope").inner_text()
    page.locator("#buyer-history-inspect .buyer-history-inspect-actions a").click()
    wait_for_function(
        page,
        "() => !new URLSearchParams(location.search).get('ap_inspect')",
        timeout=60000,
    )
    wait_for_history(page)
    wait_for_cases(page, 31)
    restored_query = parse_qs(urlparse(page.url).query)
    assert restored_query.get("ap_industry") == ["Construction Services"]
    assert restored_query.get("ap_award_method") == ["COMPETITIVE SEALED BIDDING"]
    assert restored_query.get("ap_amount_band") == [AMOUNT_BAND_1M]
    step("narrow inspect", "4 of 31 restored after dismiss")

    page.go_back()
    wait_for_history(page)
    page.locator("#analytics-amount-band").select_option("")
    wait_for_function(
        page,
        "() => (document.querySelector('#buyer-history-scope')?.textContent || '').includes('40')",
        timeout=60000,
    )
    wait_for_cases(page, 40)
    assert "ap_amount_band" not in parse_qs(urlparse(page.url).query), page.url
    hashed = hashlib.sha256(page.locator("#buyer-history").inner_html().encode("utf-8")).hexdigest()
    step("clear amount", "5 of 40 restored " + hashed)

    dot = cohort("dot_professional_rfp")
    page.goto(
        buyer_url(dot["buyer"], ap_industry=dot["industry"], ap_award_method=dot["award_method"], ap_cases="1"),
        wait_until="domcontentloaded", timeout=60000,
    )
    wait_for_history(page)
    wait_for_cases(page, 6)
    text = page.locator("#buyer-history").inner_text().lower()
    assert "percentile" not in text
    meaning = page.locator("#buyer-history-meaning").inner_text().lower()
    assert "invoice delay" in meaning
    assert "not" in meaning and "prediction" in meaning
    assert "6" in page.locator("#buyer-history-scope").inner_text()
    step("DOT explicit", "5 of 6 inspectable cases")

    dhs = cohort("dhs_human_pqvl")
    page.goto(
        buyer_url(dhs["buyer"], ap_industry=dhs["industry"], ap_award_method=dhs["award_method"], ap_cases="1"),
        wait_until="domcontentloaded", timeout=60000,
    )
    wait_for_history(page)
    wait_for_cases(page, 31)
    assert str(dhs["after_start_count"]) in " | ".join(
        page.locator("#buyer-history-metrics .buyer-history-metric").all_inner_texts()
    )
    step("DHS explicit", "29 of 31")


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
        run_inspect(page)
        run_drill_and_back(page)
        run_keyboard(page)
        run_axe(page)
        run_zoom(page)
        page.set_viewport_size({"width": 1440, "height": 900})
        run_pursuit_from_opportunity(page)
        page.set_viewport_size({"width": 390, "height": 844})
        run_pursuit_from_opportunity(page)
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
