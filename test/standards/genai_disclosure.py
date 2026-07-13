#!/usr/bin/env python3
"""GenAI content-disclosure presence gate (w10-05) — NYC Web Content Style Guide GenAI
tools section: "You should also disclose the use of generative AI to your audience."

about.html already disclosed Claude for Ask-box query processing (the Privacy section),
but nothing disclosed that the site's own COPY is AI-drafted with human review — and this
repo's copy substantially is. attribution.py-style presence check (pure text, no browser)
so a future copy edit can't silently drop the disclosure.
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).parents[2]


def load_strings():
    out = subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);console.log(JSON.stringify(window.STRINGS))",
         str(ROOT / "i18n.js")], text=True)
    return json.loads(out)


def main():
    failures = []
    about = (ROOT / "about.html").read_text(encoding="utf-8")

    if 'data-i18n="about_h_content"' not in about:
        failures.append("about.html: missing the \"About our content\" section (about_h_content)")
    if 'data-i18n="about_p_content"' not in about:
        failures.append("about.html: missing the content-disclosure paragraph (about_p_content)")

    strings = load_strings()
    for lang in ("en", "es"):
        text = strings.get(lang, {}).get("about_p_content", "")
        if not text:
            failures.append(f"i18n.js: about_p_content missing for lang={lang!r}")
        elif "Claude" not in text and "IA" not in text and "AI" not in text:
            failures.append(f"i18n.js: about_p_content ({lang}) doesn't name the AI assistant used")

    if failures:
        print("genai-disclosure gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print("genai-disclosure gate OK — about.html discloses AI-drafted site copy (en+es)")


if __name__ == "__main__":
    main()
