"""RTL support guard (w8-03) — hermetic, fixture-driven, for Arabic (ar) and Urdu (ur).

Arabic and Urdu are the two RTL languages in the ten-language commitment. The scaffolding
half-existed before this card: LANG_META already carried dir:"rtl" and applyStrings() already
set document.documentElement.dir, so switching to Arabic mirrored the root direction while
every physical left/right CSS property in index.html stayed put — worse than not flipping at
all. This spec is the mechanical proof that the CSS logical-properties migration + bidi
isolation actually took effect, not just that the dictionaries exist (13_stray_english.py
already covers translation completeness for ar/ur once CROL_GUARD_LANGS includes them).

Three checks per language:
  1. dir/lang propagation — document.documentElement carries dir="rtl" and lang=<code>.
  2. Logical-property mirroring — a handful of chrome elements that use logical CSS
     properties (border-inline-start, padding-inline-start, inset-inline-start) resolve to
     the OPPOSITE physical side under RTL vs the LTR baseline. This is a spot check, not
     exhaustive — see AGENTS.md for the full audited property list.
  3. Bidi isolation of English data islands — a notice title rendered via enTitle() (English
     data embedded in RTL chrome) computes unicode-bidi:isolate and direction:ltr, so its
     punctuation/numerals can't reorder against the surrounding Arabic/Urdu text (WCAG 1.3.2).

Plus a no-horizontal-scroll check at two viewport widths (375px mobile, 1280px desktop) — a
mirrored layout with a leftover physical property is the classic way to silently introduce an
overflow that a LTR-only check would never catch.
"""
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

ROOT = pathlib.Path(__file__).parents[2]
BASE = os.environ.get("CROL_BASE", "")
RTL_LANGS = ["ar", "ur"]


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def check_lang(pw, lang):
    failures = []
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    install_routes(page)
    page.goto(BASE, timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1000)

    # Baseline (English) physical resolution, BEFORE switching -- what "mirrored" is relative to.
    skip_x_ltr = page.locator(".skip").evaluate("el => el.getBoundingClientRect().x")
    border_ltr = page.locator(".tag").first.evaluate(
        "el => [getComputedStyle(el).marginLeft, getComputedStyle(el).marginRight]")

    btn = page.locator(f'#langSwitcher .lang-btn[data-lang="{lang}"]')
    if not btn.count():
        failures.append(f"{lang}: no language selector button — add it before activating RTL")
        browser.close()
        return failures
    btn.click()
    page.wait_for_timeout(1200)

    # 1. dir/lang propagation.
    html_dir = page.evaluate("document.documentElement.getAttribute('dir')")
    html_lang = page.evaluate("document.documentElement.getAttribute('lang')")
    if html_dir != "rtl":
        failures.append(f"{lang}: document.documentElement.dir={html_dir!r}, expected 'rtl'")
    if html_lang != lang:
        failures.append(f"{lang}: document.documentElement.lang={html_lang!r}, expected {lang!r}")

    # 2. Logical-property mirroring, spot-checked two ways.
    # 2a. .skip (skip-to-content link): inset-inline-start:-9999px must push it off the
    #     OPPOSITE physical edge under RTL -- off-screen LEFT in en, off-screen RIGHT in ar/ur.
    skip_x_rtl = page.locator(".skip").evaluate("el => el.getBoundingClientRect().x")
    if not (skip_x_ltr < 0 and skip_x_rtl > 0):
        failures.append(
            f"{lang}: .skip did not mirror off-screen side (ltr x={skip_x_ltr}, rtl x={skip_x_rtl}) "
            "-- inset-inline-start may have regressed to a physical left/right")
    # 2b. .tag (margin-inline-end): the resolved physical margin side must swap.
    margin_rtl = page.locator(".tag").first.evaluate(
        "el => [getComputedStyle(el).marginLeft, getComputedStyle(el).marginRight]")
    if margin_ltr := border_ltr:  # noqa: F841 (readability alias only)
        pass
    if not (border_ltr[1] != "0px" and margin_rtl[0] != "0px"):
        failures.append(
            f"{lang}: .tag margin-inline-end did not mirror (ltr={border_ltr}, rtl={margin_rtl}) "
            "-- expected the non-zero side to swap from right to left")

    # 3. Bidi isolation of an English data island (enTitle()-wrapped notice title on the
    #    default money-tab/open-RFP view, no extra navigation needed).
    rtitle = page.locator(".rtitle span[lang='en']").first
    if rtitle.count():
        bidi = rtitle.evaluate("el => [getComputedStyle(el).unicodeBidi, getComputedStyle(el).direction]")
        if bidi[0] != "isolate" or bidi[1] != "ltr":
            failures.append(
                f"{lang}: enTitle() span computed [unicodeBidi, direction]={bidi}, "
                "expected ['isolate', 'ltr'] -- English notice titles will bidi-reorder "
                "inside RTL chrome (WCAG 1.3.2)")
    else:
        failures.append(f"{lang}: no .rtitle English-data span found to check bidi isolation on")

    # No horizontal overflow at mobile + desktop widths -- the classic symptom of a missed
    # physical property (an element still anchored off one edge overflows the other under RTL).
    for w, h in ((375, 800), (1280, 900)):
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(150)
        overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        if overflow > 1:  # 1px slop for scrollbar rounding
            failures.append(f"{lang}: horizontal overflow of {overflow}px at {w}x{h}")

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

    failed = False
    with sync_playwright() as pw:
        for lang in RTL_LANGS:
            violations = check_lang(pw, lang)
            if violations:
                failed = True
                step("FAIL", f"RTL guard[{lang}]", f"{len(violations)} issue(s)")
                for v in violations:
                    print(f"   {v}")
            else:
                step("OK", f"RTL guard[{lang}]", "dir/lang propagation, logical-property mirroring, bidi isolation, no overflow")

    if server:
        server.shutdown()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
