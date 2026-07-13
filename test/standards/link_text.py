#!/usr/bin/env python3
"""Descriptive-link-text lint (maintainer addition, wave 7) — NYC Web Content Style Guide:
link text must make sense out of context (no naked "click here" / "read more" / "here").

Static, deterministic, house-style companion to stray_english.py: extracts every <a ...>...</a>
from the six HTML pages (both plain markup and the HTML template literals built in JS —
the same raw-source string is scanned either way), resolves any t("key") call in the link
text to its English dictionary value (i18n.js is the source of truth for what actually
renders), and flags any link whose resolved text collapses to a generic phrase. An
aria-label on the anchor overrides the visible-text judgement (a legitimate a11y escape
hatch: icon-only links named via aria-label are not "click here").

Baseline: fails on NEW generic-text findings; ALLOWLIST (below) is the tracked register for
anything deliberately kept generic, with a reason — same shrink-only posture as
stray_english_allowlist.txt.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]

GENERIC_PHRASES = {
    "click here", "click", "here", "read more", "more", "more info", "more information",
    "learn more", "see more", "this link", "this", "link", "details", "view", "info",
    "go", "continue",
}

# (page, verbatim link inner text) pairs allowed to stay generic, with a reason on file.
ALLOWLIST = set()

A_TAG_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.DOTALL)
ARIA_LABEL_RE = re.compile(r'aria-label=["\']([^"\']*)["\']')
T_CALL_RE = re.compile(r"""\$\{t\(\s*["']([a-zA-Z0-9_]+)["'](?:\s*,[^)]*)?\)\}""")
DYNAMIC_RE = re.compile(r"\$\{[^}]*\}")
TAG_RE = re.compile(r"<[^<>]*>")


def load_strings_en():
    out = subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);console.log(JSON.stringify(window.STRINGS))",
         str(ROOT / "i18n.js")], text=True)
    return json.loads(out).get("en", {})


def resolve_text(inner, strings_en):
    had_dynamic = False

    def sub_t(m):
        return strings_en.get(m.group(1), m.group(1))
    inner = T_CALL_RE.sub(sub_t, inner)
    if DYNAMIC_RE.search(inner):
        had_dynamic = True
        inner = DYNAMIC_RE.sub(" ", inner)
    inner = TAG_RE.sub(" ", inner)
    inner = re.sub(r"[↗←→]", " ", inner)
    inner = re.sub(r"\s+", " ", inner).strip()
    return inner, had_dynamic


def main():
    strings_en = load_strings_en()
    findings = []
    for page in PAGES:
        src = (ROOT / page).read_text(encoding="utf-8")
        for m in A_TAG_RE.finditer(src):
            attrs, inner = m.group(1), m.group(2)
            aria = ARIA_LABEL_RE.search(attrs)
            if aria and aria.group(1).strip():
                continue  # accessible name comes from aria-label, not visible text
            text, had_dynamic = resolve_text(inner, strings_en)
            if had_dynamic and not text:
                continue  # purely dynamic content (a name/URL) — nothing to judge
            if not text:
                continue  # icon-only with no aria-label is an a11y finding, not a link-text one
            if text.lower() in GENERIC_PHRASES and (page, text) not in ALLOWLIST:
                findings.append(f"{page}: generic link text {text!r}")

    if findings:
        print("link-text lint FAILED — link text must make sense out of context "
              "(NYC Web Content Style Guide):", file=sys.stderr)
        for f in findings:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"link-text lint OK — no generic link text across {len(PAGES)} page(s)")


if __name__ == "__main__":
    main()
