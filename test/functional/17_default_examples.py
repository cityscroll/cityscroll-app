"""Land and People + organizations expose concrete data on a bare tab open.

The retained Staffing route owns the unified people-organizations document: a blank search
is not a prerequisite, while a query-carrying deep link refines its already-visible typed
rows. Hermetic fixture routes keep both guarantees in CI without live-network dependence.
The selected examples are committed seeds, not current-data picks, while deep links still
win over the defaults. Exams remain on their separate Browse route.
"""
import os
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from ci_waits import (  # noqa: E402
    click_and_wait_for_route,
    click_and_wait_for_url,
    goto_and_wait_for_app,
    wait_for_function,
    wait_for_locator,
    wait_for_route_module,
    wait_for_route_state,
)
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

    goto_and_wait_for_app(page, f"{BASE}#land", timeout=30000)
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
    """A bare People tab renders people and organizations, not the Exams guide."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    goto_and_wait_for_app(page, f"{BASE}#people", timeout=30000)
    wait_for_locator(
        page.locator('[data-browse-concept="people"] [data-civic-object-kind="community-board"]').first,
        timeout=CI_WAIT_TIMEOUT_MS,
        label="bare People + organizations example",
    )
    if page.locator('#people-organizations-type option[value="agency"]').count() != 1:
        failures.append("bare #people did not expose organizations alongside people")
    if page.locator("#career-guide").is_visible():
        failures.append("bare #people exposed the exam guide")
    route = page.evaluate("({ pathname: location.pathname, search: location.search, hash: location.hash })")
    if route != {"pathname": "/browse/people/", "search": "", "hash": ""}:
        failures.append(f"bare #people did not forward to the clean People route — got: {route!r}")
    if page.locator("#people-organizations-search").input_value():
        failures.append("bare #people unexpectedly requires or injects a people search")

    # Every source entry is a clean document entry, and each entry focus lands on
    # that lens's heading rather than a list or demoted section.
    for tab, heading in (
        ("money", ""),
        ("people", ""),
        ("land", ""),
        ("property", ""),
        ("rules", ""),
        ("meetings", ""),
    ):
        expected_path = f"/browse/{ {'money':'contracts','people':'people','land':'zoning'}.get(tab, tab) }/"
        step("TRACE", "route transition", f"{tab} -> {expected_path}")
        if tab == "property":
            goto_and_wait_for_app(page, f"{BASE}browse/property/", timeout=30000)
            wait_for_route_state(
                page,
                expected_path,
                timeout=CI_WAIT_TIMEOUT_MS,
                label="property document route",
            )
        elif tab == "people":
            click_and_wait_for_url(
                page,
                '.tabbtn[data-tab="people"]',
                f"{BASE}browse/people/",
                timeout=CI_WAIT_TIMEOUT_MS,
            )
            wait_for_locator(
                page.locator('[data-browse-concept="people"] [data-civic-object-kind="community-board"]').first,
                timeout=CI_WAIT_TIMEOUT_MS,
                label="People concept document after tab navigation",
            )
        else:
            click_tab_and_wait_for_route(page, tab, expected_path)
        route = page.evaluate("({ pathname: location.pathname, search: location.search, hash: location.hash })")
        if route != {"pathname": expected_path, "search": "", "hash": ""}:
            failures.append(f"{tab} tab did not mint its clean document route — got: {route!r}")
        actual_focus = page.evaluate("document.activeElement?.id")
        if tab == "property":
            # Property is reached through the Land + property group's existing
            # child route. Its static document does not own SPA tab focus. Return
            # through Money's canonical document rather than the legacy #money
            # redirect: app readiness on that temporary document can resolve before
            # its replacement navigation and overwrite the next tab click.
            goto_and_wait_for_app(page, f"{BASE}browse/contracts/", timeout=30000)
            wait_for_route_state(
                page,
                "/browse/contracts/",
                tab="money",
                require_focus=True,
                timeout=CI_WAIT_TIMEOUT_MS,
                label="Money reset route",
            )
        elif tab == "people":
            if page.locator('[data-browse-concept="people"] [data-civic-object-kind="community-board"]').count() == 0:
                failures.append("people entry did not render the unified People + organizations document")
            if page.locator("#career-guide").is_visible():
                failures.append("people entry rendered the Exams guide")
        else:
            if page.evaluate("document.activeElement?.classList.contains('lens-entry-heading')") is not True:
                failures.append(f"{tab} entry focus did not land on its lens heading — got: {actual_focus!r}")
    browser.close()
    return failures


def deep_link_still_overrides_the_default(pw):
    """A query-carrying permalink refines the visible people-organizations rows."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    goto_and_wait_for_app(page, f"{BASE}#people?q=RODRIGUEZ", timeout=30000)
    wait_for_function(
        page,
        """() => {
            const query = document.querySelector("#people-organizations-search")?.value;
            const rows = [...document.querySelectorAll("[data-people-organizations-list] .people-org-row")];
            return query === "RODRIGUEZ"
                && rows.length > 0
                && rows.every((row) => row.textContent.toUpperCase().includes("RODRIGUEZ"));
        }""",
        timeout=CI_WAIT_TIMEOUT_MS,
        attempts=1,
        label="staffing deep-link readiness",
    )
    query = page.locator("#people-organizations-search").input_value()
    if query != "RODRIGUEZ":
        failures.append(f"#people?q=RODRIGUEZ did not populate the people search — got: {query!r}")
    rows = page.locator("[data-people-organizations-list] .people-org-row")
    if rows.count() == 0 or any("RODRIGUEZ" not in row.inner_text().upper() for row in rows.all()):
        failures.append("the query permalink did not refine every unified people row to Rodriguez")
    route = page.evaluate("({ pathname: location.pathname, query: new URLSearchParams(location.search).get('q'), hash: location.hash })")
    if route != {"pathname": "/browse/people/", "query": "RODRIGUEZ", "hash": ""}:
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
