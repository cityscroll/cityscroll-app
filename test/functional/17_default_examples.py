"""crol-tabland-z8: the Money tab opens on a concrete selected notice (search()'s
"auto-open the first result" — index.html:1020) so a first-time visitor sees what the tab
does with zero clicks. Land and Staffing did not match that pattern: Land requires clicking
into the tab before anything renders (fine — that's true of Money too, until you count that
Money is the tab active on the very first paint), and Staffing's pSearch() flatly refuses to
search at all with no typed keyword ("Try a title like…" / "Pick a role…", index.html:1616-
1617) — there was no live-computed example to fall back to.

Investigating turned up a split: Land's list-render already auto-clicks its first row
(landRenderList(), index.html — the 2026-06-26 "auto-open the first result" commit covered
money/land/people-role/people-person list renders alike), so a bare #land hash already
resolves to a populated #ldetail — confirmed empirically against these same fixtures before
any code changed here. Staffing was the real gap: pSearchRoles()/pSearchPeople() never run
without a keyword, so there was nothing for that auto-click to click.

The fix (index.html's applyPeopleDefault()/defaultRoleTitle()) queries the payroll dataset
for the single highest-headcount title (live, never hardcoded — computed the same way Land's
"most recent" is computed from current_milestone_date DESC) and feeds it through the exact
same pSearch() path a typed keyword or a "Try" chip would use, once, only when the tab opens
with an empty #pkw and pmode="role" — a query-carrying deep link (#people?q=<title>) or the
user typing before the fetch resolves both win over the default, matching Land's existing
"an explicit boro/status/q param always overrides the default listing" behavior. The applied
default deliberately does NOT decorate the address bar (mirrors updateHash()'s pre-existing
"don't decorate a fresh default load" carve-out for bare Money) — sharing a bare #people link
should keep showing #people, not silently pin to today's picked title forever.

Hermetic (i18n_fixtures, no live network) — same fixture layer as
test/functional/13_stray_english.py and 16_forecast_discoverability.py.
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
    """BEFORE: bare #people showed "Try a title like…" / "Pick a role…" — no keyword, no
    search, ever. AFTER: the highest-headcount title (live-queried, fixture picks "AGENCY
    ATTORNEY" at n=120 over "ASSOCIATE ATTORNEY" at n=45) pre-selects, rendering both the
    role list and its salary-band/career-ladder detail with zero clicks — same posture as
    Land above, and the auto-pick doesn't decorate the address bar either."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    page.goto(f"{BASE}#people", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    detail_text = page.locator("#pdetail").inner_text().strip()
    if "Pick a role" in detail_text or not detail_text:
        failures.append(f"bare #people still shows the empty prompt instead of an example — got: {detail_text!r}")
    if "AGENCY ATTORNEY" not in detail_text:
        failures.append(f"bare #people did not pre-select the highest-headcount fixture title — got: {detail_text!r}")
    list_text = page.locator("#plist").inner_text().strip()
    if "Try a title like" in list_text or not list_text:
        failures.append(f"bare #people's role list stayed on the empty prompt — got: {list_text!r}")
    if page.evaluate("location.hash") != "#people":
        failures.append("bare #people's default selection decorated the address bar")
    kw_val = page.locator("#pkw").input_value()
    if kw_val != "AGENCY ATTORNEY":
        failures.append(f"#pkw field should surface the picked example (like a 'Try' chip does) — got: {kw_val!r}")
    browser.close()
    return failures


def deep_link_still_overrides_the_default(pw):
    """A query-carrying permalink (#people?q=<title>) must keep winning over the live-picked
    default — the default only ever applies to a genuinely bare open."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    page.goto(f"{BASE}#people?q=ASSOCIATE", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    kw_val = page.locator("#pkw").input_value()
    if kw_val != "ASSOCIATE":
        failures.append(f"#people?q=ASSOCIATE was overridden by the default — #pkw got: {kw_val!r}")
    if page.evaluate("location.hash") != "#people?q=ASSOCIATE":
        failures.append(f"#people?q=ASSOCIATE permalink was rewritten — got: {page.evaluate('location.hash')!r}")
    browser.close()
    return failures


def main():
    global BASE
    server = None
    if not BASE:
        import http.server, threading, functools
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
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
