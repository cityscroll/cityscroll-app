"""Stray-English guard (LL30/EO120 hardening) — hermetic, fixture-driven, per-language.

The 2026-07-13 regression class: dynamically-BUILT strings (template literals, data-derived
labels like section names) bypass the i18n layer, so switching to Español still painted
"36 notices from 16 agencies" and raw section names. Static data-i18n checks can't see
those — this guard renders the real app against a fixture dataset (no live network),
switches language, drives every lens, and walks all VISIBLE text for English-looking
words outside an explicit allowlist.

What may legitimately stay English (and how each is allowed):
  * official notice content        → content-zone selectors (allowlist JSON) + fixture data values
  * data values (agencies, titles,
    vendors, methods, statuses)    → exported by i18n_fixtures.data_values()
  * approved translations          → every fragment of STRINGS[lang] in i18n.js (self-maintaining:
                                     ship a translation and the guard accepts it)
  * proper nouns / acronyms        → allowed_terms / allowed_exact in the allowlist JSON
  * native-name language labels    → any subtree with an explicit lang="en" attribute

Section names are deliberately NOT data-allowed: they render as navigation chrome and must
translate (the Today strip bug).

Parameterized by language: CROL_GUARD_LANGS="es" (comma-separated) — extend as each LL30
language's dictionary ships (wave 7). Run standalone (serves itself) or under run.sh.

Parameterized by page too: CROL_GUARD_PAGES="index,about,data,stats,api,changelog"
(comma-separated, default "index") — since 2026-07-13. "index" gets the full
lens-driving walk below (money/people/land/... tabs, investigation workspace, named
regression fixtures); every other page gets a lighter walk (load, switch language, walk
visible text) since subpages have no lens state to exercise. Approved translations are
shared across pages (dict_fragments() scans the whole STRINGS[lang] table), so adding a
subpage's es strings to i18n.js is what makes its guard cell go green — no allowlist
change needed per page.
"""
import json
import os
import re
import subprocess
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "standards"))
from i18n_fixtures import install_routes, data_values  # noqa: E402
from english_words import ENGLISH_WORDS  # noqa: E402

ROOT = pathlib.Path(__file__).parents[2]
BASE = os.environ.get("CROL_BASE", "")
LANGS = [l.strip() for l in os.environ.get("CROL_GUARD_LANGS", "es").split(",") if l.strip()]
PAGES = [p.strip() for p in os.environ.get("CROL_GUARD_PAGES", "index").split(",") if p.strip()]
ALLOWLIST = json.loads((pathlib.Path(__file__).parent / "assets" / "stray_english_allowlist.json").read_text())

def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)

# ---- approved translations: every plain-text fragment of STRINGS[lang] from i18n.js ----
def load_strings():
    out = subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);console.log(JSON.stringify(window.STRINGS))",
         str(ROOT / "i18n.js")], text=True)
    return json.loads(out)


def dict_fragments(strings, lang):
    frags = set()
    for v in strings.get(lang, {}).values():
        v = re.sub(r"<[^>]+>", "\x00", v)          # split at markup
        v = re.sub(r"\{[a-zA-Z_]+\}", "\x00", v)   # split at {vars}
        for f in v.split("\x00"):
            f = f.strip()
            if len(f) >= 3:
                frags.add(f)
    return sorted(frags, key=len, reverse=True)

DATA_VALUES = sorted(data_values(), key=len, reverse=True)
ALLOWED_TERMS = set(ALLOWLIST["allowed_terms"])  # case-sensitive, as printed
ALLOWED_EXACT = set(ALLOWLIST["allowed_exact"])
ALLOWED_PHRASES = sorted(ALLOWLIST["allowed_phrases"], key=len, reverse=True)
CONTENT_ZONES = ",".join(ALLOWLIST["content_zone_selectors"])

WORD_RE = re.compile(r"[A-Za-z]+")

def english_residue(text, frags):
    """Return the English words left after stripping everything that's allowed."""
    if text in ALLOWED_EXACT:
        return []
    for dv in DATA_VALUES:
        if dv in text:
            text = text.replace(dv, " ")
    for f in frags:
        if f in text:
            text = text.replace(f, " ")
    for p in ALLOWED_PHRASES:
        text = re.sub(re.escape(p), " ", text, flags=re.I)
    words = WORD_RE.findall(text)
    return [w for w in words if w not in ALLOWED_TERMS and w.lower() in ENGLISH_WORDS]

WALKER_JS = """(zones) => {
  const out = [];
  const path = (el) => {
    const bits = [];
    for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
      let b = e.tagName.toLowerCase();
      if (e.id) { bits.unshift(b + "#" + e.id); break; }
      if (e.classList.length) b += "." + e.classList[0];
      bits.unshift(b);
    }
    return bits.join(" > ");
  };
  const visible = (el) => {
    if (el.closest("option")) return !!el.closest("select") && visible(el.closest("select"));
    try { return el.checkVisibility(); } catch (e) { return !!(el.offsetParent || el.getClientRects().length); }
  };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode, p = n.parentElement;
    if (!p || p.closest("script,style,noscript,[hidden]")) continue;
    if (zones && p.closest(zones)) continue;
    if (p.closest('[lang="en"]') && document.documentElement.lang !== "en") continue;
    if (!visible(p)) continue;
    const t = n.textContent.replace(/\\s+/g, " ").trim();
    if (t) out.push({ sel: path(p), text: t, kind: "text" });
  }
  document.querySelectorAll("input[placeholder],textarea[placeholder]").forEach((el) => {
    if (zones && el.closest(zones)) return;
    if (visible(el) && el.placeholder.trim())
      out.push({ sel: path(el), text: el.placeholder.trim(), kind: "placeholder" });
  });
  // w9-05: aria-labels are SR-only -- invisible to the visible-text walk above, but exactly
  // where L1/L2 (hardcoded "Lenses" / "What kind of feedback?") leaked English to es users.
  document.querySelectorAll("[aria-label]").forEach((el) => {
    if (zones && el.closest(zones)) return;
    const label = el.getAttribute("aria-label").trim();
    if (visible(el) && label && !(el.closest('[lang="en"]') && document.documentElement.lang !== "en"))
      out.push({ sel: path(el), text: label, kind: "aria-label" });
  });
  return out;
}"""

def collect(page, label, frags, violations, seen):
    for item in page.evaluate(WALKER_JS, CONTENT_ZONES or None):
        key = (item["sel"], item["text"])
        if key in seen:
            continue
        seen.add(key)
        hits = english_residue(item["text"], frags)
        if hits:
            violations.append({"view": label, **item, "english_words": hits})

# Same tree-walk as WALKER_JS, but scoped to a single subtree via
# document.querySelector(rootSel) instead of document.body. The agency/vendor profile's
# surrounding chrome (agencybar, actions row, footer note) is a separate, pre-existing
# translation gap outside this card's scope (see the w9-05 comment above collect_srstatus_
# and_aria) -- an unscoped collect() on the entity view would dye THAT gap red as a
# "regression" every time this card's forecast pane is walked. Scoping to #forecast-content
# proves the NEW forecast strings translate without reopening the old, tracked-elsewhere gap.
FOCUSED_WALKER_JS = """([zones, rootSel]) => {
  const root = document.querySelector(rootSel);
  if (!root) return [];
  const out = [];
  const path = (el) => {
    const bits = [];
    for (let e = el, i = 0; e && e !== root.parentElement && i < 4; e = e.parentElement, i++) {
      let b = e.tagName.toLowerCase();
      if (e.id) { bits.unshift(b + "#" + e.id); break; }
      if (e.classList.length) b += "." + e.classList[0];
      bits.unshift(b);
    }
    return bits.join(" > ");
  };
  const visible = (el) => { try { return el.checkVisibility(); } catch (e) { return !!(el.offsetParent || el.getClientRects().length); } };
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode, p = n.parentElement;
    if (!p || p.closest("script,style,noscript,[hidden]")) continue;
    if (zones && p.closest(zones)) continue;
    if (p.closest('[lang="en"]') && document.documentElement.lang !== "en") continue;
    if (!visible(p)) continue;
    const t = n.textContent.replace(/\\s+/g, " ").trim();
    if (t) out.push({ sel: path(p), text: t, kind: "text" });
  }
  return out;
}"""

def collect_within(page, root_sel, label, frags, violations, seen):
    for item in page.evaluate(FOCUSED_WALKER_JS, [CONTENT_ZONES or None, root_sel]):
        key = (item["sel"], item["text"])
        if key in seen:
            continue
        seen.add(key)
        hits = english_residue(item["text"], frags)
        if hits:
            violations.append({"view": label, **item, "english_words": hits})

# w9-05: entity views (agency/vendor/matter profiles) aren't otherwise walked by this guard --
# their full visible-text content is a separate, much larger translation gap outside this
# card's L1-L6 scope. What the card actually asks the guard to cover is the SR-only surfaces
# those views touch: aria-labels, and #srstatus after announce() fires -- exactly the leaks
# a visible-text-only walk can't see. Scoped narrowly so this doesn't fail on the untranslated
# entity-page body text, which is tracked separately.
SRSTATUS_ARIA_JS = """(zones) => {
  const out = [];
  const visible = (el) => { try { return el.checkVisibility(); } catch (e) { return !!(el.offsetParent || el.getClientRects().length); } };
  document.querySelectorAll("[aria-label]").forEach((el) => {
    if (zones && el.closest(zones)) return;
    const label = el.getAttribute("aria-label").trim();
    if (visible(el) && label) out.push({ sel: el.tagName.toLowerCase(), text: label, kind: "aria-label" });
  });
  const sr = document.getElementById("srstatus");
  if (sr && sr.textContent.trim()) out.push({ sel: "#srstatus", text: sr.textContent.trim(), kind: "srstatus" });
  return out;
}"""

def collect_srstatus_and_aria(page, label, frags, violations, seen):
    for item in page.evaluate(SRSTATUS_ARIA_JS, CONTENT_ZONES or None):
        key = (item["sel"], item["text"])
        if key in seen:
            continue
        seen.add(key)
        hits = english_residue(item["text"], frags)
        if hits:
            violations.append({"view": label, **item, "english_words": hits})

# w9-06 (WCAG 3.1.2, "language of parts"): in es mode, City Record data values (notice
# titles) must carry lang="en" so Spanish SR voices don't mangle them, while chrome around
# them (deadline tags, section names) stays under the page's lang="es". Sampled, not
# exhaustive -- this is the DOM-structure check the w9-06 card asks for, run once in es mode.
def check_lang_of_parts(page, lang, violations):
    if lang != "es":
        return
    result = page.evaluate("""() => {
      // the lang="en" tag lives on a SPAN inside .rtitle, not the container (granularity:
      // rows interleave translated chrome with English data values on the same line)
      const title = document.querySelector('#list .row .rtitle');
      const chrome = document.querySelector('#list .row .tag') || document.querySelector('#reshead');
      const langOf = (el) => el ? (el.closest('[lang]') || document.documentElement).getAttribute('lang') : null;
      return { titleLang: langOf(title && title.querySelector('span')), chromeLang: langOf(chrome),
               hasTitle: !!(title && title.querySelector('span')), hasChrome: !!chrome };
    }""")
    if result["hasTitle"] and result["titleLang"] != "en":
        violations.append({"view": "lang-of-parts", "sel": "#list .row .rtitle", "kind": "lang-attr",
                           "text": f"closest [lang] resolved to {result['titleLang']!r}",
                           "english_words": ["expected lang=\"en\" on notice-title content"]})
    if result["hasChrome"] and result["chromeLang"] == "en":
        violations.append({"view": "lang-of-parts", "sel": "#list .row .tag / #reshead", "kind": "lang-attr",
                           "text": "chrome node incorrectly resolved to lang=\"en\"",
                           "english_words": ["chrome must resolve to the page's es lang"]})


# Named regression fixtures — the two 2026-07-13 hotfix classes, pinned by content so ANY
# future PR (including the 10-language implementation PRs) goes red if es-mode regresses.
def regression_fixtures(page, lang, strings, violations):
    if lang != "es":
        return  # the named pins are es-specific; other languages rely on the generic walk
    def pin(name, actual, must_contain):
        if must_contain not in actual:
            violations.append({"view": f"REGRESSION-FIXTURE ({name})", "sel": "-",
                               "text": actual.replace("\n", " ")[:120], "kind": "fixture",
                               "english_words": [f"expected substring {must_contain!r}"]})
    pin("hotfix-1 bug a: today-strip summary", page.locator("#tbig").inner_text(), "avisos hoy")
    pin("hotfix-1 bug b: section names translate", page.locator("#tcounts").inner_text(), "Adquisiciones")
    pin("hotfix-1: deadline tags translate", page.locator("#list").first.inner_text(), "cierra")
    pin("hotfix-2: diacritic 'Mi investigación'",
        page.locator('[data-i18n="footer_investigation"]').inner_text(), "Mi investigación")
    pin("hotfix-2: workspace heading", page.locator("#entityview").inner_text(),
        "Espacio de investigación")


def workspace_seed(strings, lang):
    """A pinned investigation item exactly as the app stores it when pinned in `lang` mode."""
    d = strings.get(lang, {})
    return {"current": "inv1", "invs": {"inv1": {
        "name": d.get("inv_default_name", "My investigation"), "created": "2026-07-10",
        "items": [{"t": "agency", "id": "Housing Preservation and Development",
                   "title": "Housing Preservation and Development (HPD)",
                   "meta": d.get("meta_agency_profile", "agency profile"),
                   "note": "", "added": "2026-07-12"}]}}}


def run_subpage(pw, lang, page, frags):
    """Lighter walk for a non-index subpage: load, switch language, walk visible text.
    Subpages have no lens/search state to drive — the shared header switcher + chrome/content
    keys added for the subpages are what's under test here."""
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    page_obj = ctx.new_page()
    install_routes(page_obj)
    page_obj.goto(f"{BASE}{page}.html", timeout=30000)
    page_obj.wait_for_load_state("load")
    page_obj.wait_for_timeout(1000)

    btn = page_obj.locator(f'#langSwitcher .lang-btn[data-lang="{lang}"]')
    assert btn.count(), f"{page}.html: no language button for {lang!r} — add the shared switcher"
    btn.click()
    page_obj.wait_for_timeout(800)

    violations, seen = [], set()
    collect(page_obj, page, frags, violations, seen)
    browser.close()
    return violations


NOTICE_PERMALINK_ID = "20260701099"  # i18n_fixtures.NOTICE_PERMALINK_ROW

# crol-hotfix3-m8: the guard never visited a #notice/ permalink at all, so the 2026-07-13
# regression -- notice-detail chrome (glance labels, action buttons, how-to-respond panel)
# staying in whatever language was active when showNotice() first built the view, never
# repainting on a later language switch -- shipped invisibly. Two distinct entry paths, both
# now covered: (1) a fresh page load that lands directly on #notice/<id> with the language
# preference already saved (the literal maintainer repro) -- this path was never actually
# broken (window.LANG/STRINGS are populated synchronously via document.write() before the
# body's router runs), but is worth pinning against a future regression; (2) navigating to a
# #notice/<id> permalink while still in English, THEN switching language in place -- this is
# the path that was actually broken (rerenderForLang() had no case for the #notice/#entity
# permalink panes, which have no .tabbtn to key off of).
def run_notice_deep_link(pw, lang, frags):
    violations = []

    # (1) fresh load, hash + saved pref both present before first paint
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    ctx.add_init_script(f"localStorage.setItem('crol_lang', {json.dumps(lang)})")
    page = ctx.new_page()
    install_routes(page)
    page.goto(f"{BASE}#notice/{NOTICE_PERMALINK_ID}", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)
    seen = set()
    collect(page, "notice-deep-link (fresh load, pref pre-saved)", frags, violations, seen)
    browser.close()

    # (2) in-app: view the notice in English first, THEN switch language in place. Loads
    # straight onto the #notice/ hash (rather than BASE then a hash change) so the default
    # money-tab search() never runs and never leaves a stale #srstatus announcement behind --
    # that would be a test artifact, not a real signal about the notice view under test.
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    page = ctx.new_page()
    install_routes(page)
    page.goto(f"{BASE}#notice/{NOTICE_PERMALINK_ID}", timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1200)
    btn = page.locator(f'#langSwitcher .lang-btn[data-lang="{lang}"]')
    assert btn.count(), f"no language button for {lang!r} — add it before activating its guard"
    btn.click()
    page.wait_for_timeout(1200)
    seen = set()
    collect(page, "notice-deep-link (switched while viewing)", frags, violations, seen)
    browser.close()

    return violations


def run_lang(pw, lang):
    strings = load_strings()
    frags = dict_fragments(strings, lang)
    step("··", f"guard[{lang}]", f"{len(frags)} approved fragments, {len(DATA_VALUES)} data values")

    all_violations = []
    for page in PAGES:
        if page != "index":
            all_violations += run_subpage(pw, lang, page, frags)
    if "index" not in PAGES:
        return all_violations
    all_violations += run_notice_deep_link(pw, lang, frags)
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    # Seed a pinned item so localStorage-gated states (the hotfix-2 blind spot: the workspace
    # only renders its full chrome with something pinned) get walked too.
    ctx.add_init_script(
        f"localStorage.setItem('crd_invs_v1', JSON.stringify({json.dumps(workspace_seed(strings, lang))}))")
    page = ctx.new_page()
    install_routes(page)
    page.goto(BASE, timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1500)

    btn = page.locator(f'#langSwitcher .lang-btn[data-lang="{lang}"]')
    assert btn.count(), f"no language button for {lang!r} — add it before activating its guard"
    btn.click()
    page.wait_for_timeout(1500)

    violations, seen = [], set()
    collect(page, "money+today", frags, violations, seen)
    check_lang_of_parts(page, lang, violations)

    page.click('.tabbtn[data-tab="people"]')
    page.fill("#pkw", "attorney")
    page.wait_for_timeout(1600)
    collect(page, "people", frags, violations, seen)

    for tab in ("land", "property", "rules", "meetings"):
        page.click(f'.tabbtn[data-tab="{tab}"]')
        page.wait_for_timeout(1800 if tab == "land" else 1200)
        collect(page, tab, frags, violations, seen)

    page.click('.tabbtn[data-tab="alerts"]')
    page.wait_for_timeout(400)
    page.click("#apreview")
    page.wait_for_timeout(1500)
    collect(page, "alerts+digest-preview", frags, violations, seen)

    # w9-05: entity view -- exercises announce()'s "Agency profile: {name}" into #srstatus
    # (L3), scoped to the SR-only surfaces (aria-labels + #srstatus), not the entity view's
    # full body text (a separate, larger translation gap outside this card's L1-L6 scope).
    # Runs BEFORE the investigation states below, which overwrite #entityview and are what
    # regression_fixtures() inspects afterward.
    page.evaluate("location.hash = '#agency/Housing Preservation and Development'")
    page.wait_for_timeout(1000)
    collect_srstatus_and_aria(page, "entity-agency", frags, violations, seen)

    # The Procurement Forecast subtab is exactly how the badge/date-label/
    # honesty-note strings shipped hardcoded English for a whole wave — collect() only walks
    # VISIBLE text, and this pane stays display:none until #btn-forecast is clicked, so no
    # amount of walking the agency view above ever touched it. Click it open so a future
    # regression (a new forecast string landing outside t()) fails here instead of shipping.
    # Scoped to #forecast-content (collect_within), not the whole entity view: the profile's
    # surrounding chrome is the pre-existing, separately-tracked gap the w9-05 comment above
    # already excludes from this guard — an unscoped walk here would flag THAT gap too, every
    # time, as if this card had regressed it.
    forecast_btn = page.locator("#btn-forecast")
    if forecast_btn.count():
        forecast_btn.click()
        page.wait_for_timeout(500)
        collect_within(page, "#forecast-content", "entity-agency-forecast", frags, violations, seen)

    # Cross-source authority awards are another dynamically-built profile surface. Drive a
    # mapped SCA profile against the official-source fixture, then scope the walk to the new
    # panel so this gate covers its translated provenance without reopening the profile's
    # larger pre-existing chrome gap.
    page.evaluate("location.hash = '#agency/School Construction Authority'")
    page.wait_for_timeout(1000)
    if page.locator("#external-awards-content").count():
        collect_within(page, "#external-awards-content", "entity-agency-external-awards", frags, violations, seen)
    else:
        violations.append({"view": "entity-agency-external-awards", "sel": "#external-awards-content",
                           "text": "panel missing", "kind": "fixture",
                           "english_words": ["expected external awards panel"]})

    # localStorage-gated states (the hotfix-2 blind spot): workspace + its share-error path
    page.evaluate("location.hash = '#investigation'")
    page.wait_for_timeout(800)
    collect(page, "investigation-workspace", frags, violations, seen)
    page.click("#invshare")  # worker is dead in fixtures → exercises the error-message strings
    page.wait_for_timeout(1200)
    collect(page, "investigation-share-error", frags, violations, seen)

    regression_fixtures(page, lang, strings, violations)

    browser.close()
    return all_violations + violations

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
        for lang in LANGS:
            violations = run_lang(pw, lang)
            if violations:
                failed = True
                step("FAIL", f"stray English in {lang} mode", f"{len(violations)} string(s)")
                for v in violations:
                    print(f"   [{v['view']}] {v['sel']} ({v['kind']}): {v['text']!r} -> {v['english_words']}")
            else:
                step("OK", f"no stray English in {lang} mode")
    if server:
        server.shutdown()
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
