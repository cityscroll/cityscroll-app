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
    pin("hotfix-1 bug a: today-strip summary", page.locator("#tbig").inner_text(), "avisos de")
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


def run_lang(pw, lang):
    strings = load_strings()
    frags = dict_fragments(strings, lang)
    step("··", f"guard[{lang}]", f"{len(frags)} approved fragments, {len(DATA_VALUES)} data values")
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

    # localStorage-gated states (the hotfix-2 blind spot): workspace + its share-error path
    page.evaluate("location.hash = '#investigation'")
    page.wait_for_timeout(800)
    collect(page, "investigation-workspace", frags, violations, seen)
    page.click("#invshare")  # worker is dead in fixtures → exercises the error-message strings
    page.wait_for_timeout(1200)
    collect(page, "investigation-share-error", frags, violations, seen)

    regression_fixtures(page, lang, strings, violations)

    browser.close()
    return violations

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
