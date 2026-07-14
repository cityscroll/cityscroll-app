#!/usr/bin/env python3
"""Static-fallback drift lint — every data-i18n* element's HTML fallback content must equal
the en dictionary's value for its key, character for character.

Why this matters (see AGENTS.md "Reading level — the readable-or-else ratchet gate"): the
ratchet's extractor drops <script>/<style> and never executes JS, so it measures the
pre-applyStrings() static markup, not what a visitor actually sees once i18n.js repaints the
page. AGENTS.md already names this exact sharp edge for that gate — "any data-i18n element's
static fallback text already sitting in the HTML source ... is measured — so a UI-copy change
... must land in the .html file's own fallback text, not just its i18n.js dictionary entry
... keep both in sync, or the page silently reverts to the old wording once JS paints." This
gate is the enforcement AGENTS.md says was missing: index.html's tab_money/money_trail_heading
fallback text drifted to "Money"/"Money trail" while the dictionary (and thus every real
pageview) had long since moved to "Contracts"/"Contract trail" — caught by hand during a
verification pass, not by any gate. Real consequences besides the ratchet: a flash of stale
content on slow connections, and permanently-stale content with JS disabled/blocked.

A second, sharper failure class caught by the same sweep: a `data-i18n` (not `-html`) element
whose static markup contains a nested tag (e.g. `<b>...</b>`) never gets its text replaced at
all — applyStrings()'s `if (el.children.length === 0)` guard silently no-ops for it, in EVERY
language forever, not just before JS paints. Three index.html empty-state hints had exactly
this shape (real translations existed in all ten shipping-language files and were never once
shown to a non-English visitor). This gate treats that the same way: a plain `data-i18n`
element's fallback must be markup-free text matching the dictionary — if a translation needs
inline markup, the element must use `data-i18n-html` instead.

Checks, per element, across all six pages (script/style content excluded — it never
participates in the pre-paint flash and often already calls t() itself):
  - `data-i18n="key"`: element must contain no nested tags, and its (HTML-unescaped,
    whitespace-collapsed) text must equal STRINGS.en[key].
  - `data-i18n-html="key"`: element's inner markup, compared with insignificant
    inter-tag whitespace normalized away (harmless formatting, not real drift), must equal
    STRINGS.en[key]'s markup.
  - `data-i18n-placeholder="key"` / `data-i18n-aria="key"`: the same tag's literal
    `placeholder=`/`aria-label=` attribute must equal STRINGS.en[key].

Dynamically-built markup (data-i18n* attributes baked into a JS template literal inside
<script>) is out of scope by construction — there is no static fallback to drift, since the
value is always freshly computed via t() when the element is built.
"""
import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# CROL_FALLBACK_SYNC_ROOT / _PAGES: test-only overrides (test/i18n_fallback_sync.test.mjs)
# so the characterization test can point this gate at a hermetic fixture directory instead
# of the real site — production runs (CI, local) always use the defaults.
ROOT = Path(os.environ.get("CROL_FALLBACK_SYNC_ROOT") or Path(__file__).resolve().parents[2])
_pages_override = os.environ.get("CROL_FALLBACK_SYNC_PAGES")
PAGES = _pages_override.split(",") if _pages_override else [
    "index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]

SCRIPT_RE = re.compile(r"<script\b.*?</script>", re.DOTALL | re.IGNORECASE)
STYLE_RE = re.compile(r"<style\b.*?</style>", re.DOTALL | re.IGNORECASE)
TAG_OPEN_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>")
ANY_TAG_RE = re.compile(r"<[^<>]*>")


def load_strings_en():
    out = subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);console.log(JSON.stringify(window.STRINGS))",
         str(ROOT / "i18n.js")], text=True)
    return json.loads(out).get("en", {})


def strip_non_content(src):
    return STYLE_RE.sub("", SCRIPT_RE.sub("", src))


def extract_attr(attrs, name):
    m = re.search(re.escape(name) + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def find_matching_close(src, tagname, start_idx):
    """Depth-track same-name tags from start_idx to find this element's true closing tag."""
    pattern = re.compile(r"<(/?)" + re.escape(tagname) + r"\b[^>]*>", re.IGNORECASE)
    depth = 1
    for m in pattern.finditer(src, start_idx):
        if m.group(1) == "/":
            depth -= 1
            if depth == 0:
                return m.start()
        elif not m.group(0).rstrip().endswith("/>"):
            depth += 1
    return None


def norm_html(s):
    """Collapse insignificant inter-tag / run whitespace, the way a browser would."""
    s = re.sub(r">\s+<", "><", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_text(s):
    return html.unescape(re.sub(r"\s+", " ", s).strip())


def main():
    strings_en = load_strings_en()
    findings = []

    for page in PAGES:
        raw = (ROOT / page).read_text(encoding="utf-8")
        src = strip_non_content(raw)
        for m in TAG_OPEN_RE.finditer(src):
            tagname, attrs = m.group(1), m.group(2)
            key = extract_attr(attrs, "data-i18n")
            key_html = extract_attr(attrs, "data-i18n-html")
            key_ph = extract_attr(attrs, "data-i18n-placeholder")
            key_aria = extract_attr(attrs, "data-i18n-aria")

            if key:
                close = find_matching_close(src, tagname, m.end())
                if close is None:
                    findings.append(f"{page}: <{tagname} data-i18n={key!r}> has no matching close tag")
                    continue
                inner = src[m.end():close]
                if ANY_TAG_RE.search(inner):
                    findings.append(
                        f"{page} [data-i18n={key}]: fallback contains nested markup "
                        f"({inner.strip()!r}) — applyStrings() only replaces textContent when "
                        f"the element has zero children, so this NEVER gets translated in any "
                        f"language; strip the markup or switch to data-i18n-html")
                else:
                    text = norm_text(inner)
                    want = strings_en.get(key)
                    if want is None:
                        findings.append(f"{page} [data-i18n={key}]: key missing from en dictionary")
                    elif text != norm_text(want):
                        findings.append(
                            f"{page} [data-i18n={key}]: fallback {text!r} != en dictionary {want!r}")

            if key_html:
                close = find_matching_close(src, tagname, m.end())
                if close is None:
                    findings.append(f"{page}: <{tagname} data-i18n-html={key_html!r}> has no matching close tag")
                    continue
                inner = norm_html(src[m.end():close])
                want = strings_en.get(key_html)
                if want is None:
                    findings.append(f"{page} [data-i18n-html={key_html}]: key missing from en dictionary")
                elif inner != norm_html(want):
                    findings.append(
                        f"{page} [data-i18n-html={key_html}]: fallback markup != en dictionary markup\n"
                        f"    fallback: {inner!r}\n"
                        f"    en dict:  {norm_html(want)!r}")

            if key_ph:
                ph = extract_attr(attrs, "placeholder")
                want = strings_en.get(key_ph)
                if want is None:
                    findings.append(f"{page} [data-i18n-placeholder={key_ph}]: key missing from en dictionary")
                elif ph is None:
                    findings.append(f"{page} [data-i18n-placeholder={key_ph}]: element has no placeholder= attribute")
                elif html.unescape(ph) != want:
                    findings.append(
                        f"{page} [data-i18n-placeholder={key_ph}]: placeholder={ph!r} != en dictionary {want!r}")

            if key_aria:
                aria = extract_attr(attrs, "aria-label")
                want = strings_en.get(key_aria)
                if want is None:
                    findings.append(f"{page} [data-i18n-aria={key_aria}]: key missing from en dictionary")
                elif aria is None:
                    findings.append(f"{page} [data-i18n-aria={key_aria}]: element has no aria-label= attribute")
                elif html.unescape(aria) != want:
                    findings.append(
                        f"{page} [data-i18n-aria={key_aria}]: aria-label={aria!r} != en dictionary {want!r}")

    if findings:
        print("i18n fallback-sync lint FAILED — static fallback drifted from the en dictionary:",
              file=sys.stderr)
        for f in findings:
            print(f"  {f}", file=sys.stderr)
        sys.exit(f"i18n_fallback_sync gate: {len(findings)} finding(s)")

    print(f"i18n fallback-sync OK — every data-i18n* fallback matches en across {len(PAGES)} page(s)")


if __name__ == "__main__":
    main()
