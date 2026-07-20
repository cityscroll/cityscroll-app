"""The README's headline promise ("track upcoming solicitation
opportunities 6 months before they are formally published") pointed at real code that
was practically unreachable — a Procurement Forecast pane that only existed as a
display:none secondary subtab inside an agency/vendor profile, and a profile is itself
only reached by already knowing to search for a specific agency or vendor. There was no
path from any primary surface (the Money tab, a notice you're already reading) to it at
all, and every string in the pane was hardcoded English regardless of language.

Two characterization tests pin the fix, hermetically (i18n_fixtures, no live network —
same fixture layer test/functional/13_stray_english.py uses):

  1. reachable_from_notice_detail — BEFORE: nothing on the notice-detail view (the Money
     tab's split-pane detail panel, and the #notice/<id> permalink page) hinted a forecast
     existed. AFTER: a quiet cross-link teaser renders directly there (no extra click past
     what a reader already does to read a notice) and its link deep-links straight into
     the agency profile with the Forecast subtab pre-selected — no need to already know
     the hidden subtab is there to find it.
  2. forecast_strings_translate_in_a_sampled_language — the newly-keyed strings (badges,
     section heading, honesty note, teaser copy) actually render in a non-English
     language, not just in the STRINGS table (a "the key exists" check would pass even if
     nothing calls t() correctly at render time).

The timeline-item HTML *shape* itself (badge/title/subtitle/subscribe-button structure) is
pinned separately, without a browser, in test/forecast_render.test.mjs — this file is
about placement and language, not re-litigating that shape.
"""
import os
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

ROOT = pathlib.Path(__file__).parents[2]
BASE = os.environ.get("CROL_BASE", "")
NOTICE_PERMALINK_ID = "20260701099"  # i18n_fixtures.NOTICE_PERMALINK_ROW — agency_name matches
                                      # FORECAST_ROWS, so its /inv/ lookup returns real forecasts


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def reachable_from_notice_detail(pw):
    """AFTER: the notice-detail teaser renders unprompted and its link opens the forecast pane."""
    failures = []
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)

    # (a) the #notice/<id> permalink page — showNotice()'s #nforecast slot.
    page.goto(f"{BASE}#notice/{NOTICE_PERMALINK_ID}", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    teaser = page.locator("#nforecast")
    text = teaser.inner_text().strip()
    if not text:
        failures.append("notice permalink: #nforecast rendered no teaser (forecast content still unreachable from here)")
    link = teaser.locator("a.pivot")
    if link.count() == 0:
        failures.append("notice permalink: teaser has no link into the full forecast")
    else:
        href = link.get_attribute("href")
        if "tab=forecast" not in (href or ""):
            failures.append(f"notice permalink: teaser link {href!r} doesn't deep-link to the forecast subtab")
        link.click()
        page.wait_for_timeout(1200)
        pane = page.locator("#forecast-content")
        if pane.count() == 0 or not pane.is_visible():
            failures.append("notice permalink: following the teaser link did not land on a visible forecast pane")
        elif "Estimated renewal" not in pane.inner_text() and "Agency plan" not in pane.inner_text():
            failures.append("notice permalink: forecast pane opened but has no forecast items")
    browser.close()

    # (b) the Money tab's split-pane notice detail — renderDetail()'s #dforecast slot,
    # reached the way a reader actually gets there: pick a notice, no extra click.
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)
    page.goto(BASE, timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1800)  # search() auto-selects the first result -> renderDetail()
    dteaser = page.locator("#dforecast")
    dtext = dteaser.inner_text().strip()
    if not dtext:
        failures.append("money-tab detail panel: #dforecast rendered no teaser after picking a notice")
    browser.close()

    return failures


def forecast_strings_translate_in_a_sampled_language(pw, lang="es"):
    """The forecast pane's and the teaser's strings actually render translated, not just
    exist in the dictionary."""
    failures = []
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    ctx.add_init_script(f"localStorage.setItem('crol_lang', {lang!r})")
    page = ctx.new_page()
    install_routes(page)

    page.goto(f"{BASE}#notice/{NOTICE_PERMALINK_ID}", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    teaser_text = page.locator("#nforecast").inner_text()
    if "Ver el pronóstico completo" not in teaser_text:
        failures.append(f"es notice teaser did not translate — got: {teaser_text!r}")
    if "next predicted bid windows" in teaser_text.lower():
        failures.append("es notice teaser still shows the English heading")

    page.evaluate("location.hash = '#agency/Housing Preservation and Development'")
    page.wait_for_timeout(1200)
    btn = page.locator("#btn-forecast")
    if btn.count() == 0:
        failures.append("es agency profile: no Forecast subtab rendered")
    else:
        # .subtab is styled text-transform:uppercase — compare case-insensitively, that's
        # rendering, not a translation gap.
        subtab_label = btn.inner_text().lower()
        if "pronóstico de adquisiciones" not in subtab_label:
            failures.append(f"es Forecast subtab button did not translate — got: {subtab_label!r}")
        btn.click()
        page.wait_for_timeout(600)
        pane_text = page.locator("#forecast-content").inner_text().lower()
        for expected in ("vencimientos previstos y calendarios planificados", "renovación estimada", "plan de la agencia", "son estimaciones basadas"):
            if expected not in pane_text:
                failures.append(f"es forecast pane missing translated text {expected!r} — got: {pane_text!r}")
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
            ("reachable_from_notice_detail", lambda: reachable_from_notice_detail(pw)),
            ("forecast_strings_translate_in_a_sampled_language", lambda: forecast_strings_translate_in_a_sampled_language(pw)),
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
