"""External-link new-tab characterization gate.

Symptom this pins: a user reported that "View in City Record" and "Bid on PASSPort" — both
reached mid-way through reading a notice or drafting a response — navigated the whole tab
away from CityScroll, discarding search/filter state. BEFORE this change, both links were
plain same-tab anchors (the w10-03 house default, test/standards/link_targets.py); clicking
either replaced the app in place. AFTER, both carry target="_blank" rel="noopener noreferrer"
plus a visually-hidden "opens in new tab" marking, so the tab stays open behind the new one
and a screen-reader user is told before activating the link that it leaves the app.

The Staffing rebuild replaced salary-band search results with a posting-first appointment
feed. Its City Record links carry the same new-tab treatment, so opening a source record does
not discard the list's search and filters.

Broadened ruling (crol-extlinks2-y8): the product owner extended the new-tab treatment from a
named allowlist (City Record / PASSPort / Checkbook NYC / NYC Open Data) to EVERY external
destination — only CityScroll's own resources (crol-list.org, api.cityscroll.org, in-app hash
routes, the project's own GitHub repo) stay same-tab now. About's NYC Charter/amlegal
citation — previously the gate's own "stays same-tab" control fixture — is a perfect example:
BEFORE crol-extlinks2-y8 it was a deliberate same-tab exception (an external destination
outside the then-narrow allowlist); AFTER, it gets the same new-tab treatment as every other
external link, so this gate now asserts the OPPOSITE of what it asserted before. The former
negative control is replaced with two new ones: an in-app hash link (unchanged) and stats.html's
own api.cityscroll.org link (CityScroll's own resource, must never acquire target="_blank").

This gate proves it on real rendered output: the notice-detail links (City Record, PASSPort)
and the Staffing feed's City Record link get the new-tab treatment, the broadened case (the
NYC Charter citation, previously same-tab) now also gets it, an ordinary in-app link does not
regress into acquiring target="_blank", and CityScroll's own api.cityscroll.org link stays
same-tab.
"""
import os
import pathlib
import sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes, NOTICE_PERMALINK_ROW  # noqa: E402

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
NOTICE_ID = NOTICE_PERMALINK_ROW["request_id"]  # a Solicitation — renders both reported links

results = []


def step(tag, name, detail=""):
    results.append((tag, name))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def link_info(page, selector):
    loc = page.locator(selector)
    assert loc.count() == 1, f"expected exactly one match for {selector!r}, got {loc.count()}"
    return loc.evaluate("""el => ({
        target: el.getAttribute("target"),
        rel: el.getAttribute("rel"),
        srText: (el.querySelector(".sr-only") || {}).textContent || null,
    })""")


failures = []

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    page = ctx.new_page()
    install_routes(page)
    page.goto(f"{BASE}#notice/{NOTICE_ID}", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)

    # --- Reported link 1: "View in City Record" -------------------------------------------
    info = link_info(page, '#noticeview a.act[href*="a856-cityrecord.nyc.gov"]')
    if info["target"] != "_blank":
        failures.append(f'"View in City Record": target={info["target"]!r}, want "_blank" '
                         "(the app-navigates-away regression this gate pins)")
    elif not info["rel"] or "noopener" not in info["rel"] or "noreferrer" not in info["rel"]:
        failures.append(f'"View in City Record": rel={info["rel"]!r}, want noopener+noreferrer')
    elif not info["srText"] or not info["srText"].strip():
        failures.append('"View in City Record": no accessible new-tab marking (.sr-only child)')
    else:
        step("OK", '"View in City Record" opens in a new tab', f"rel={info['rel']!r}")

    # --- Reported link 2: "Bid on PASSPort" ------------------------------------------------
    info = link_info(page, '#noticeview a.act[href="https://a0333-passportpublic.nyc.gov/"]')
    if info["target"] != "_blank":
        failures.append(f'"Bid on PASSPort": target={info["target"]!r}, want "_blank" '
                         "(the app-navigates-away regression this gate pins)")
    elif not info["rel"] or "noopener" not in info["rel"] or "noreferrer" not in info["rel"]:
        failures.append(f'"Bid on PASSPort": rel={info["rel"]!r}, want noopener+noreferrer')
    elif not info["srText"] or not info["srText"].strip():
        failures.append('"Bid on PASSPort": no accessible new-tab marking (.sr-only child)')
    else:
        step("OK", '"Bid on PASSPort" opens in a new tab', f"rel={info['rel']!r}")

    # --- Staffing feed source record -------------------------------------------------------
    page.goto(f"{BASE}#people", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    staffing_link = page.locator(
        '#staffing-notice-list .staffing-notice-card a[href*="a856-cityrecord.nyc.gov"]'
    ).first
    if staffing_link.count() != 1:
        failures.append("Staffing feed: expected a City Record link on the newest appointment")
    else:
        info = staffing_link.evaluate("""el => ({
            target: el.getAttribute("target"),
            rel: el.getAttribute("rel"),
            srText: (el.querySelector(".sr-only") || {}).textContent || null,
        })""")
        if info["target"] != "_blank":
            failures.append(f'Staffing feed City Record link: target={info["target"]!r}, want "_blank"')
        elif not info["rel"] or "noopener" not in info["rel"] or "noreferrer" not in info["rel"]:
            failures.append(f'Staffing feed City Record link: rel={info["rel"]!r}, want noopener+noreferrer')
        elif not info["srText"] or not info["srText"].strip():
            failures.append("Staffing feed City Record link: no accessible new-tab marking (.sr-only child)")
        else:
            step("OK", "Staffing feed source opens in a new tab", f"rel={info['rel']!r}")

    # --- Control: an in-app link must NOT regress into acquiring target="_blank" -----------
    # The footer's "My investigation" link (#investigation) is present on every page load —
    # no fixture-dependent state needed to reach it.
    home_target = page.locator('footer a[href="#investigation"]').first.get_attribute("target")
    if home_target is not None:
        failures.append(f'in-app "My investigation" link acquired target={home_target!r} — '
                         "in-app navigation must keep replacing the current tab")
    else:
        step("OK", 'in-app "My investigation" link stays same-tab', "target=None")

    browser.close()

    # --- Broadened case (crol-extlinks2-y8): About's NYC Charter citation now opens in a new
    # tab too — BEFORE this ruling it was the gate's own "stays same-tab" negative control;
    # AFTER, every external destination gets the same treatment as City Record/PASSPort. -----
    browser = pw.chromium.launch()
    page2 = browser.new_context().new_page()
    page2.goto(f"{BASE}about.html", timeout=30000)
    page2.wait_for_load_state("load")
    info = page2.locator('a[href*="codelibrary.amlegal.com"]').first.evaluate("""el => ({
        target: el.getAttribute("target"),
        rel: el.getAttribute("rel"),
        srText: (el.querySelector(".sr-only") || {}).textContent || null,
    })""")
    if info["target"] != "_blank":
        failures.append(f'about.html\'s NYC Charter citation: target={info["target"]!r}, want '
                         '"_blank" (crol-extlinks2-y8 broadened the new-tab rule to every '
                         "external destination)")
    elif not info["rel"] or "noopener" not in info["rel"] or "noreferrer" not in info["rel"]:
        failures.append(f"about.html's NYC Charter citation: rel={info['rel']!r}, want noopener+noreferrer")
    elif not info["srText"] or not info["srText"].strip():
        failures.append("about.html's NYC Charter citation: no accessible new-tab marking (.sr-only child)")
    else:
        step("OK", "about.html's NYC Charter citation opens in a new tab (crol-extlinks2-y8)", f"rel={info['rel']!r}")

    # --- Control: an in-app hash link on the same page must NOT acquire target="_blank" ----
    home_target2 = page2.locator('a.backhome[href="index.html"]').first.get_attribute("target")
    if home_target2 is not None:
        failures.append(f'about.html\'s "Back to CityScroll" link acquired target={home_target2!r} '
                         "— in-app/own navigation must keep replacing the current tab")
    else:
        step("OK", 'about.html\'s "Back to CityScroll" link stays same-tab (own resource)', "target=None")
    browser.close()

    # --- Control: CityScroll's own api.cityscroll.org link must NOT acquire target="_blank" --
    # (crol-extlinks2-y8: own resources are the only exemption from the blanket new-tab rule)
    browser = pw.chromium.launch()
    page3 = browser.new_context().new_page()
    page3.goto(f"{BASE}stats.html", timeout=30000)
    page3.wait_for_load_state("load")
    api_target = page3.locator('a[href*="api.cityscroll.org/stats"]').first.get_attribute("target")
    if api_target is not None:
        failures.append(f"stats.html's api.cityscroll.org link acquired target={api_target!r} "
                         "— CityScroll's own resources stay same-tab even under the broadened rule")
    else:
        step("OK", "stats.html's api.cityscroll.org link stays same-tab (own resource)", "target=None")
    browser.close()

assert not failures, f"external-links gate: {len(failures)} failure(s): {failures}"
print("✅ external-links gate green")
