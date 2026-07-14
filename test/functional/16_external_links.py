"""External-link new-tab characterization gate (crol-extlinks-s9).

Symptom this pins: a user reported that "View in City Record" and "Bid on PASSPort" — both
reached mid-way through reading a notice or drafting a response — navigated the whole tab
away from CROL-List, discarding search/filter state. BEFORE this change, both links were
plain same-tab anchors (the w10-03 house default, test/standards/link_targets.py); clicking
either replaced the app in place. AFTER, both carry target="_blank" rel="noopener noreferrer"
plus a visually-hidden "opens in new tab" marking, so the tab stays open behind the new one
and a screen-reader user is told before activating the link that it leaves the app.

This is a NARROW, named carve-out (City Record / PASSPort / Checkbook NYC only — see
link_targets.py's docstring) — every other external destination still opens same-tab. This
gate proves both halves on real rendered output: the two reported links get the new-tab
treatment, an ordinary in-app link does not regress into acquiring target="_blank", and a
non-allowlisted external link (About's NYC Charter citation) stays same-tab exactly as
before.
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

    # --- Control: a non-allowlisted external link stays same-tab (w10-03 default) ----------
    browser = pw.chromium.launch()
    page2 = browser.new_context().new_page()
    page2.goto(f"{BASE}about.html", timeout=30000)
    page2.wait_for_load_state("load")
    charter_target = page2.locator('a[href*="codelibrary.amlegal.com"]').first.get_attribute("target")
    if charter_target is not None:
        failures.append(f"about.html's NYC Charter citation acquired target={charter_target!r} "
                         "— only City Record/PASSPort/Checkbook NYC links open in a new tab")
    else:
        step("OK", "about.html's NYC Charter citation stays same-tab (non-allowlisted external)", "target=None")
    browser.close()

assert not failures, f"external-links gate: {len(failures)} failure(s): {failures}"
print("✅ external-links gate green")
