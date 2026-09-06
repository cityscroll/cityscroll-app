"""Deep-link handoff for the retired changelog route, plus stats availability."""
import json
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

    # Search use: the section renders from the published summary alone. When a period is
    # measured it appears as a dated column; when the summary is unavailable the section
    # says so. Neither path may show an undated number, and no path shows a zero for a
    # period nobody measured.
    page.wait_for_selector("#search-use", timeout=15000)
    page.wait_for_function(
        "() => document.querySelector('#search-use').children.length > 0", timeout=20000)
    use = page.locator("#search-use")
    if use.locator("table.cov").count():
        rows = use.locator("table.cov tbody tr")
        assert rows.count() == 2, f"expected the two published measures, saw {rows.count()}"
        for label in ("Searches run", "Searches returning records"):
            assert use.locator(f"table.cov tbody th:text-is('{label}')").count() == 1, label
        heads = use.locator("table.cov thead th.period")
        assert heads.count() >= 1, "a measured period rendered without a column"
        for index in range(heads.count()):
            assert heads.nth(index).locator("small").inner_text().strip(), \
                "a period rendered a count without naming the days it covers"
        assert use.locator("dl.use-defs dd").count() == 2, "each published measure states what it counts"
        print(f"OK stats page renders search use over {heads.count()} dated period(s)")
    else:
        note = use.inner_text().strip().lower()
        assert "not published" in note, f"unexpected search-use state: {note!r}"
        print("OK stats page states search use is not published rather than showing a zero")

    # The measured path, rendered in a real browser against a fixture response so the
    # assertion does not depend on what production happens to have measured today. Both
    # published periods appear, each with its own dates, and an unmeasured period renders
    # as a state rather than as a zero.
    published = {
        "schema": "public-stats.v4",
        "search_usage": {
            "schema": "cityscroll.public_search_usage.v1",
            "available": True,
            "unavailable_reason": None,
            "generated_at": "2026-09-15T12:00:00.000Z",
            "measurement": {
                "family": "search_usage",
                "population": "Accepted production search-execution receipts.",
                "population_key": "stats_search_use_run_desc",
                "subset_rule": "Searches returning records is a subset of searches run.",
                "state": "complete",
                "measured_since": "2026-07-01T00:00:00.000Z",
            },
            "refresh": {
                "state": "fresh",
                "verified_at": "2026-09-15T12:00:00.000Z",
                "attempted_at": "2026-09-15T12:00:00.000Z",
                "failure_reason": None,
            },
            "periods": [
                {
                    "period_id": "last7d", "requested_days": 7, "state": "measured",
                    "coverage": "complete", "unavailable_reason": None,
                    "starts_at": "2026-09-09T00:00:00.000Z", "ends_at": "2026-09-15T12:00:00.000Z",
                    "metrics": [
                        {"metric_id": "searches_run", "label_key": "stats_search_use_run_label",
                         "definition_key": "stats_search_use_run_desc", "state": "measured", "value": 6},
                        {"metric_id": "searches_returning_records", "label_key": "stats_search_use_returning_label",
                         "definition_key": "stats_search_use_returning_desc", "state": "measured", "value": 4},
                    ],
                },
                {
                    "period_id": "last30d", "requested_days": 30, "state": "unavailable",
                    "coverage": "unavailable", "unavailable_reason": "measurement_incomplete",
                    "starts_at": None, "ends_at": None,
                    "metrics": [
                        {"metric_id": "searches_run", "label_key": "stats_search_use_run_label",
                         "definition_key": "stats_search_use_run_desc", "state": "unavailable", "value": None},
                        {"metric_id": "searches_returning_records", "label_key": "stats_search_use_returning_label",
                         "definition_key": "stats_search_use_returning_desc", "state": "unavailable", "value": None},
                    ],
                },
            ],
        },
    }
    page.route("**/stats", lambda route: route.fulfill(
        status=200,
        headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        body=json.dumps(published),
    ))
    page.goto(BASE + "stats.html", timeout=30000)
    page.wait_for_selector("#search-use table.cov tbody tr", timeout=15000)
    use = page.locator("#search-use")
    assert use.locator("table.cov tbody tr").count() == 2
    week = use.locator("table.cov tbody tr").nth(0)
    assert week.locator("th").inner_text().strip() == "Searches run"
    assert week.locator("td").nth(0).inner_text().strip() == "6"
    # The state chip is upper-cased by the page's own type styling, so compare on the word.
    assert week.locator("td").nth(1).inner_text().strip().lower() == "not published", \
        "an unmeasured period must render as a state, never as a zero"
    returning = use.locator("table.cov tbody tr").nth(1)
    assert returning.locator("td").nth(0).inner_text().strip() == "4"
    heads = use.locator("table.cov thead th.period")
    assert heads.nth(0).inner_text().lower().startswith("last 7 days")
    assert heads.nth(0).locator("small").inner_text().strip(), "the measured period names its days"
    assert use.locator("dl.use-defs dd").count() == 2
    print("OK stats page renders published search counts and leaves an unmeasured period unpublished")

    browser.close()
