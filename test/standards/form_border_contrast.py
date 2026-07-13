#!/usr/bin/env python3
"""w9-08 (WCAG 1.4.11): form-control boundaries must use --rule-strong (3.56:1+), not --rule
(1.58-1.81:1) -- the border is the only indicator of a text field's extent. Decorative
hairlines (cards, dividers, chip/button outlines that also carry visible text) are exempt;
this only gates real form controls (input, select, textarea).

Grep-level lint: for each <style> block, find rule bodies whose selector list names a form
control tag and whose declarations set a `border*` property to var(--rule) (not --rule-strong).
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "changelog.html", "api.html"]

FORM_TAG = re.compile(r"(?<![\w.#-])(input|select|textarea)\b")
BAD_BORDER = re.compile(r"border(?:-\w+)?\s*:\s*[^;]*var\(--rule\)(?!-strong)")

failures = []
for name in PAGES:
    path = ROOT / name
    if not path.exists():
        continue
    src = path.read_text(encoding="utf-8")
    for style_block in re.findall(r"<style>(.*?)</style>", src, re.DOTALL):
        for rule in re.findall(r"([^{}]+)\{([^{}]*)\}", style_block):
            selector, body = rule
            if FORM_TAG.search(selector) and BAD_BORDER.search(body):
                failures.append(f"{name}: selector `{selector.strip()}` borders on --rule, not --rule-strong")

if failures:
    print("form-control border contrast lint FAILED:", file=sys.stderr)
    for f in failures:
        print(f"  {f}", file=sys.stderr)
    sys.exit(1)

print(f"form-control border contrast OK across {len(PAGES)} pages")
