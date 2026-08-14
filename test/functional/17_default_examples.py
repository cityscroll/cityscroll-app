"""Land and Staffing expose concrete data on a bare tab open.

Staffing is posting-first: a blank search is not a prerequisite. Its newest City Record
appointments render immediately in reverse chronological order, while a query-carrying
deep link refines the already-visible list. Hermetic fixture routes keep both guarantees in
CI without live-network dependence. The selected examples are committed seeds, not
current-data picks, while deep links still win over the defaults.
"""
import os
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from ci_waits import click_and_wait_for_route, wait_for_locator, wait_for_route_module  # noqa: E402
from i18n_fixtures import install_routes  # noqa: E402

ROOT = pathlib.Path(__file__).parents[2]
BASE = os.environ.get("CROL_BASE", "")
CI_WAIT_TIMEOUT_MS = 60_000


def click_tab_and_wait_for_route(page, tab, expected_path):
    """Wait for a tab's same-document route after its module is ready.

    Rules and Meetings are route-module-backed tabs. Start their module load and wait
    for readiness before clicking so the click cannot be consumed while ``showTab``
    is still deferring the transition. The route is then observed through its URL and
    active-pane state; the assertions below still verify the resulting document and
    focus state.
    """
    selector = f'.tabbtn[data-tab="{tab}"]'
    wait_for_route_module(page, tab)
    click_and_wait_for_route(
        page,
        selector,
        expected_path,
        tab=tab,
        timeout=CI_WAIT_TIMEOUT_MS,
    )


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def land_opens_on_a_populated_example(pw):
    """Bare #land opens the committed fixture project without a click."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    page.goto(f"{BASE}#land", timeout=30000)
    page.wait_for_load_state("load")
    wait_for_locator(page.locator("#ldetail"), timeout=CI_WAIT_TIMEOUT_MS, label="bare Land example")
    detail = page.locator("#ldetail")
    text = detail.inner_text().strip()
    if "Pick a rezoning" in text or not text:
        failures.append(f"bare #land still shows the empty prompt instead of an example — got: {text!r}")
    if "example street rezoning" not in text.lower():
        failures.append(f"bare #land did not pre-select the committed fixture project — got: {text!r}")
    route = page.evaluate("({ pathname: location.pathname, search: location.search, hash: location.hash })")
    if route != {"pathname": "/browse/zoning/", "search": "", "hash": ""}:
        failures.append(f"bare #land did not forward to the clean Zoning route — got: {route!r}")
    browser.close()
    return failures


def people_opens_on_a_populated_example(pw):
    """A bare Staffing tab renders actionable exams and keeps appointments collapsed."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    page.goto(f"{BASE}#people", timeout=30000)
    page.wait_for_load_state("load")
    wait_for_locator(
        page.locator("#career-results .career-card").first,
        timeout=CI_WAIT_TIMEOUT_MS,
        label="bare Staffing example",
    )
    first = page.locator("#career-results .career-card").first
    first_text = first.inner_text().strip()
    if "APPLY BY" not in first_text.upper():
        failures.append(f"bare #people did not lead with an exam deadline — got: {first_text!r}")
    if page.locator("#staffing-ledger").get_attribute("open") is not None:
        failures.append("bare #people opened the appointments ledger above the action path")
    if page.locator("#staffing-notice-list .staffing-hire-row").count() != 4:
        failures.append("bare #people did not retain all four appointment fixtures in the ledger")
    route = page.evaluate("({ pathname: location.pathname, search: location.search, hash: location.hash })")
    if route != {"pathname": "/browse/staffing/", "search": "", "hash": ""}:
        failures.append(f"bare #people did not forward to the clean Staffing route — got: {route!r}")
    if page.locator("#career-query").input_value():
        failures.append("bare #people unexpectedly requires or injects an exam search")
    if page.evaluate("document.activeElement?.id") != "career-browser-heading":
        failures.append(
            "bare #people did not place initial focus on the action heading — got: "
            f"{page.evaluate('document.activeElement?.id')!r}"
        )

    # Every source entry is a clean document entry, and each entry focus lands on
    # that lens's heading rather than a list or demoted section.
    for tab, heading in (
        ("money", ""),
        ("people", "career-browser-heading"),
        ("land", ""),
        ("property", ""),
        ("rules", ""),
        ("meetings", ""),
    ):
        expected_path = f"/browse/{ {'money':'contracts','people':'staffing','land':'zoning'}.get(tab, tab) }/"
        if tab == "property":
            page.goto(f"{BASE}browse/property/", timeout=30000)
            page.wait_for_load_state("load")
        else:
            click_tab_and_wait_for_route(page, tab, expected_path)
        page.wait_for_timeout(100)
        route = page.evaluate("({ pathname: location.pathname, search: location.search, hash: location.hash })")
        if route != {"pathname": expected_path, "search": "", "hash": ""}:
            failures.append(f"{tab} tab did not mint its clean document route — got: {route!r}")
        actual_focus = page.evaluate("document.activeElement?.id")
        if tab == "property":
            # Property is reached through the Land + property group's existing
            # child route. Its static document does not own SPA tab focus.
            page.goto(BASE, timeout=30000)
            page.wait_for_load_state("load")
        elif tab == "people":
            if actual_focus != heading:
                failures.append(f"{tab} entry focus landed on {actual_focus!r}, not {heading!r}")
        else:
            if page.evaluate("document.activeElement?.classList.contains('lens-entry-heading')") is not True:
                failures.append(f"{tab} entry focus did not land on its lens heading — got: {actual_focus!r}")
    browser.close()
    return failures


def deep_link_still_overrides_the_default(pw):
    """A query-carrying permalink refines the visible notice feed."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    page.goto(f"{BASE}#people?q=RODRIGUEZ", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    query = page.locator("#staffing-query").input_value()
    if query != "RODRIGUEZ":
        failures.append(f"#people?q=RODRIGUEZ did not populate the list search — got: {query!r}")
    rows = page.locator("#staffing-notice-list .staffing-hire-row")
    if rows.count() != 1 or "RODRIGUEZ,LUIS A." not in rows.first.inner_text():
        failures.append("the query permalink did not refine the appointment list to Rodriguez")
    route = page.evaluate("({ pathname: location.pathname, query: new URLSearchParams(location.search).get('q'), hash: location.hash })")
    if route != {"pathname": "/browse/staffing/", "query": "RODRIGUEZ", "hash": ""}:
        failures.append(f"#people?q=RODRIGUEZ did not forward to its clean equivalent — got: {route!r}")
    browser.close()
    return failures


def main():
    global BASE
    server = None
    if not BASE:
        import http.server, threading, functools
        sys.path.insert(0, str(ROOT))
        from tools.local_site_server import QuietHandler
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        BASE = f"http://127.0.0.1:{server.server_address[1]}/"

    from playwright.sync_api import sync_playwright
    failed = False
    with sync_playwright() as pw:
        for name, fn in (
            ("land_opens_on_a_populated_example", lambda: land_opens_on_a_populated_example(pw)),
            ("people_opens_on_a_populated_example", lambda: people_opens_on_a_populated_example(pw)),
            ("deep_link_still_overrides_the_default", lambda: deep_link_still_overrides_the_default(pw)),
        ):
            failures = fn()
            if failures:
                failed = True
                step("FAIL", name, f"{len(failures)} issue(s)")
                for f in failures:
                    print(f"   {f}")
            else:
                step("OK", name)
    if server:
        server.shutdown()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
