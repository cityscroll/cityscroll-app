"""Land and Staffing expose concrete data on a bare tab open.

Staffing is posting-first: a blank search is not a prerequisite. Its newest City Record
appointments render immediately in reverse chronological order, while a query-carrying
deep link refines the already-visible list. Hermetic fixture routes keep both guarantees in
CI without live-network dependence.
"""
import os
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

ROOT = pathlib.Path(__file__).parents[2]
BASE = os.environ.get("CROL_BASE", "")


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def land_opens_on_a_populated_example(pw):
    """Regression pin, not a fix: bare #land already renders a real, live-picked project
    (most-recent by current_milestone_date) with zero clicks — verified so this can't
    silently regress once Staffing is made to match it."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    page.goto(f"{BASE}#land", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    detail = page.locator("#ldetail")
    text = detail.inner_text().strip()
    if "Pick a rezoning" in text or not text:
        failures.append(f"bare #land still shows the empty prompt instead of an example — got: {text!r}")
    if "example street rezoning" not in text.lower():  # fixture's most-recent ZAP row (current_milestone_date DESC), enTitle() uppercases it
        failures.append(f"bare #land did not pre-select the most-recent fixture project — got: {text!r}")
    if page.evaluate("location.hash") != "#land":
        failures.append("bare #land's default selection decorated the address bar")
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
    page.wait_for_timeout(1500)
    first = page.locator("#career-results .career-card").first
    first.wait_for(state="visible")
    first_text = first.inner_text().strip()
    if "APPLY BY" not in first_text.upper():
        failures.append(f"bare #people did not lead with an exam deadline — got: {first_text!r}")
    if page.locator("#staffing-ledger").get_attribute("open") is not None:
        failures.append("bare #people opened the appointments ledger above the action path")
    if page.locator("#staffing-notice-list .staffing-hire-row").count() != 4:
        failures.append("bare #people did not retain all four appointment fixtures in the ledger")
    if page.evaluate("location.hash") != "#people":
        failures.append("bare #people's default feed decorated the address bar")
    if page.locator("#career-query").input_value():
        failures.append("bare #people unexpectedly requires or injects an exam search")
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
    if page.evaluate("location.hash") != "#people?q=RODRIGUEZ":
        failures.append(f"#people?q=RODRIGUEZ permalink was rewritten — got: {page.evaluate('location.hash')!r}")
    browser.close()
    return failures


def main():
    global BASE
    server = None
    if not BASE:
        import http.server, threading, functools
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "site"))
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
