#!/usr/bin/env python3
"""Heading-punctuation lint (w10-04) — NYC Web Content Style Guide Headings: "Don't
include punctuation (such as colons, periods...) in headings. The exception is question
marks."

Scans h1/h2/h3 across the six pages, resolving `data-i18n`/`data-i18n-html` headings and
`${t("key")}` headings against STRINGS.en (i18n.js is the source of truth). Two carve-outs:

  * changelog.html's dated release <h2> titles (`chg_*_h2` keys) — an archival register of
    what actually shipped, presented verbatim; the same posture the heading-order gate and
    nyc_copy_lint's ampersand rule already give these headings.
  * Headings built from DATASET VALUES at runtime (role titles, agency/vendor names, project
    names — anything with a non-t() `${...}` expression) — these aren't authored copy, they're
    the record's own text, so a copy-style lint doesn't apply to them any more than
    stray_english.py enforces i18n on City Record notice content.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]

H_TAG_RE = re.compile(r"<(h[1-3])\b([^>]*)>(.*?)</h[1-3]>", re.DOTALL)
DATA_I18N_RE = re.compile(r'data-i18n(?:-html)?="([a-zA-Z0-9_]+)"')
T_CALL_RE = re.compile(r"""^\$\{t\(\s*["']([a-zA-Z0-9_]+)["'](?:\s*,[^)]*)?\)\}$""")
DYNAMIC_RE = re.compile(r"\$\{")
TAG_RE = re.compile(r"<[^<>]*>")
BANNED_PUNCT_RE = re.compile(r"[:.](?!\.\.)")  # colon or period; '?' is the guide's own exception

# changelog's archival per-release titles — presented verbatim, not retrofitted copy.
ARCHIVAL_KEY_PREFIX = "chg_"


def load_strings_en():
    out = subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);console.log(JSON.stringify(window.STRINGS))",
         str(ROOT / "i18n.js")], text=True)
    return json.loads(out).get("en", {})


def resolve_heading(inner, strings_en):
    """Return (text, skip) — skip=True for dataset-value headings out of copy-lint scope."""
    inner = inner.strip()
    m = T_CALL_RE.match(inner)
    if m:
        return strings_en.get(m.group(1), inner), False
    if DYNAMIC_RE.search(inner):
        return inner, True  # a data field is interpolated — not authored copy
    return re.sub(r"\s+", " ", TAG_RE.sub(" ", inner)).strip(), False


def main():
    strings_en = load_strings_en()
    failures = []

    for page in PAGES:
        src = (ROOT / page).read_text(encoding="utf-8")
        for m in H_TAG_RE.finditer(src):
            attrs, inner = m.group(2), m.group(3)
            key_m = DATA_I18N_RE.search(attrs)
            if key_m:
                key = key_m.group(1)
                if page == "changelog.html" and key.startswith(ARCHIVAL_KEY_PREFIX):
                    continue
                text = strings_en.get(key, inner)
                text = re.sub(r"\s+", " ", TAG_RE.sub(" ", text)).strip()
            else:
                text, skip = resolve_heading(inner, strings_en)
                if skip:
                    continue
            if not text:
                continue
            if BANNED_PUNCT_RE.search(text):
                failures.append(f"{page}: heading has banned punctuation (colon/period): {text!r}")

    if failures:
        print("heading-punctuation gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"heading-punctuation gate OK — h1/h2/h3 across {len(PAGES)} page(s) clean "
          f"(changelog's archival release titles carved out)")


if __name__ == "__main__":
    main()
