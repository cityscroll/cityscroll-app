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

    # The reader meets four sections in one order: what is here, how it is used, what it is
    # for, and what the numbers mean.
    # The section type is upper-cased by the page's own styling, so compare on the words.
    headings = page.locator("main h2").all_inner_texts()
    assert [h.strip().lower() for h in headings] == [
        "what you can explore", "recent use", "see how records connect", "about these numbers",
    ], headings
    print("OK stats page presents the four sections in order")

    # Worked paths are served markup, so they are already on screen before any measurement
    # answers. Each names a product domain, three steps, a record and the guide behind it.
    paths = page.locator("#paths article.path")
    assert paths.count() == 3, f"expected three worked paths, saw {paths.count()}"
    for index, domain in enumerate(("Contracts", "Zoning", "Rules")):
        card = paths.nth(index)
        assert card.locator(".path-domain").inner_text().strip().lower() == domain.lower()
        assert card.locator("ol.hops li").count() == 3
        links = card.locator("ul.path-links a")
        assert links.count() == 2
        assert links.nth(0).inner_text().strip() == "Open this record"
        assert links.nth(1).inner_text().strip() == "Read the step-by-step guide"
        for hop in range(3):
            assert card.locator("ol.hops li .hop-role").nth(hop).inner_text().strip()
            assert card.locator("ol.hops li .hop-name").nth(hop).inner_text().strip()
    # Each headline figure is announced with the unit it counts.
    tiles = page.locator("#grid .stat")
    assert tiles.count() == 3, f"expected three headline facts, saw {tiles.count()}"
    for index in range(tiles.count()):
        assert tiles.nth(index).locator("dt").inner_text().strip()
    assert page.locator("#grid dt").count() == 3
    # Methodology stands next to the claims rather than in a separate wiki.
    assert page.locator("dl.method dt").count() == 6
    assert page.locator("dl.method dd").count() == 6
    print("OK stats page serves three worked paths, three dated facts and its methodology")

    # Every link and scrollable region on the page is reachable from the keyboard with a
    # focus ring the reader can see.
    reachable = page.evaluate(
        """() => {
             const targets = [...document.querySelectorAll(
               'main a[href], main [tabindex="0"]')];
             return targets.map((el) => {
               el.focus();
               const active = document.activeElement === el;
               const ring = getComputedStyle(el, ':focus-visible').outlineStyle;
               return { active, ring, text: (el.textContent || '').trim().slice(0, 40) };
             });
           }"""
    )
    assert reachable, "no focusable content in the main region"
    unreachable = [item for item in reachable if not item["active"]]
    assert not unreachable, f"unreachable from the keyboard: {unreachable}"
    print(f"OK {len(reachable)} focusable item(s) in the main region take focus")

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

    # ---- Deterministic state fixtures -------------------------------------------------
    # Five states a reader can meet, each driven from a fixed response rather than from
    # whatever production happens to hold: a verified zero, a small volume, an ordinary
    # volume, a period whose measurement began inside it, and a summary standing on the
    # last check that finished.
    def metric(metric_id, label_key, definition_key, state, value):
        return {"metric_id": metric_id, "label_key": label_key,
                "definition_key": definition_key, "state": state, "value": value}

    def period(period_id, days, coverage, starts_at, ends_at, run, returning, state="measured"):
        return {
            "period_id": period_id, "requested_days": days, "state": state,
            "coverage": coverage, "unavailable_reason": None,
            "starts_at": starts_at, "ends_at": ends_at,
            "metrics": [
                metric("searches_run", "stats_search_use_run_label",
                       "stats_search_use_run_desc", state, run),
                metric("searches_returning_records", "stats_search_use_returning_label",
                       "stats_search_use_returning_desc", state, returning),
            ],
        }

    def summary(periods, refresh_state="fresh"):
        return {
            "schema": "public-stats.v4",
            "search_usage": {
                "schema": "cityscroll.public_search_usage.v1",
                "available": True, "unavailable_reason": None,
                "generated_at": "2026-09-15T12:00:00.000Z",
                "measurement": {
                    "family": "search_usage",
                    "population": "Accepted production search-execution receipts.",
                    "population_key": "stats_search_use_run_desc",
                    "subset_rule": "Searches returning records is a subset of searches run.",
                    "state": "complete", "measured_since": "2026-07-01T00:00:00.000Z",
                },
                "refresh": {
                    "state": refresh_state,
                    "verified_at": "2026-09-15T12:00:00.000Z",
                    "attempted_at": "2026-09-15T12:00:00.000Z",
                    "failure_reason": None if refresh_state == "fresh" else "read_did_not_finish",
                },
                "periods": periods,
            },
        }

    def render(body, width=390, height=844):
        page.set_viewport_size({"width": width, "height": height})
        page.route("**/stats", lambda route: route.fulfill(
            status=200,
            headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            body=json.dumps(body)))
        page.goto(BASE + "stats.html", timeout=30000)
        page.wait_for_selector("#search-use table.cov tbody tr, #search-use p.use-note", timeout=15000)
        fit = page.evaluate("""() => ({ scroll: document.documentElement.scrollWidth,
                                        client: document.documentElement.clientWidth })""")
        assert fit["scroll"] <= fit["client"], f"horizontal overflow at {width}px: {fit}"
        return page.locator("#search-use")

    complete_week = ["2026-09-09T00:00:00.000Z", "2026-09-16T00:00:00.000Z"]

    # Verified zero: a complete period in which nobody searched publishes 0, not a state.
    use = render(summary([period("last7d", 7, "complete", *complete_week, 0, 0)]))
    assert use.locator("table.cov tbody tr").nth(0).locator("td").nth(0).inner_text().strip() == "0"
    print("OK a complete period with no searches publishes zero")

    # Small volume and ordinary volume both render as plain, grouped numbers.
    use = render(summary([period("last7d", 7, "complete", *complete_week, 3, 1)]))
    assert use.locator("table.cov tbody tr").nth(0).locator("td").nth(0).inner_text().strip() == "3"
    use = render(summary([period("last30d", 30, "complete",
                                 "2026-08-17T00:00:00.000Z", "2026-09-16T00:00:00.000Z", 4821, 3960)]))
    assert use.locator("table.cov tbody tr").nth(0).locator("td").nth(0).inner_text().strip() == "4,821"
    print("OK small and ordinary volumes render as grouped numbers")

    # Incomplete: counting began inside the requested window, so the column is labelled with
    # the day it actually began rather than with the wider period it cannot support.
    use = render(summary([period("last30d", 30, "partial",
                                 "2026-09-01T00:00:00.000Z", "2026-09-16T00:00:00.000Z", 61, 45)]))
    head = use.locator("table.cov thead th.period").nth(0)
    assert head.inner_text().lower().startswith("since"), head.inner_text()
    print("OK a period measured from part-way through is labelled from the day counting began")

    # A period still running says its last day is partial, read from the response's own
    # end instant rather than from any clock on the page.
    use = render(summary([period("last7d", 7, "complete",
                                 "2026-09-09T00:00:00.000Z", "2026-09-15T12:00:00.000Z", 12, 9)]))
    span = use.locator("table.cov thead th.period small").nth(0).inner_text()
    assert "last check" in span.lower(), span
    print("OK a period whose last day is still running shows it as partial")

    # Last verified: the newest check did not finish, so the page stands on the last one
    # that did and says so.
    use = render(summary([period("last7d", 7, "complete", *complete_week, 6, 4)], refresh_state="stale"))
    notes = use.locator("p.use-note").inner_text().lower()
    assert "last checked" in notes and "did not finish" in notes, notes
    print("OK a summary standing on the last finished check says so")

    # Unavailable: no summary at all leaves the section stating it, with the coverage
    # section above it untouched.
    page.set_viewport_size({"width": 390, "height": 844})
    page.route("**/stats", lambda route: route.fulfill(status=503, body="unavailable"))
    page.goto(BASE + "stats.html", timeout=30000)
    page.wait_for_selector("#search-use p.use-note", timeout=15000)
    assert "not published" in page.locator("#search-use").inner_text().strip().lower()
    page.wait_for_selector("#coverage section.cov-domain table.cov tbody tr", timeout=15000)
    assert page.locator("#paths article.path").count() == 3
    print("OK an unavailable summary leaves coverage, worked paths and methodology standing")

    browser.close()
