#!/usr/bin/env python3
"""Static outline:none guard (w7-03 companion) — a focus ring suppressed in CSS is invisible
to axe (axe checks markup, not computed :focus-visible styles); this catches the SOURCE pattern
before it ships. Companion to the runtime keyboard walk (test/functional/14_focus_visible.py).

Fails if any CSS rule sets `outline:none`/`outline-style:none` on a selector that has no
matching `:focus-visible` replacement rule giving that same selector a visible outline
(or box-shadow) — i.e. focus is hidden with nothing standing in for it.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]

SUPPRESS_RE = re.compile(r"([^{}]+)\{[^{}]*\boutline\s*:\s*(?:none|0)\b[^{}]*\}")
FOCUS_VISIBLE_RE = re.compile(r"([^{}]+):focus-visible\s*\{([^{}]*)\}")


def style_block(src):
    m = re.search(r"<style>(.*?)</style>", src, re.DOTALL)
    return m.group(1) if m else ""


def has_visible_replacement(selector, css):
    # A :focus-visible rule for the same selector (or one of its comma-separated parts, or an
    # :is(...)/:where(...) group containing it) that sets a non-none outline or a box-shadow.
    targets = {s.strip() for s in selector.split(",")}
    for sel, body in FOCUS_VISIBLE_RE.findall(css):
        sel_targets = {s.strip() for s in sel.split(",")}
        # :is(a,b,c):focus-visible expands to a set containing each of a/b/c
        for t in sel_targets:
            m = re.match(r":is\(([^)]*)\)$", t) or re.match(r":where\(([^)]*)\)$", t)
            if m:
                sel_targets |= {p.strip() for p in m.group(1).split(",")}
        if targets & sel_targets:
            if re.search(r"outline\s*:\s*(?!none\b|0\b)\S", body) or "box-shadow" in body:
                return True
    return False


def main():
    failures = []
    for page in PAGES:
        src = (ROOT / page).read_text(encoding="utf-8")
        css = style_block(src)
        for selector, in [(m.group(1),) for m in SUPPRESS_RE.finditer(css)]:
            if not has_visible_replacement(selector, css):
                failures.append(f"{page}: {selector.strip()!r} sets outline:none/0 with no "
                                 ":focus-visible replacement")
    if failures:
        print("outline guard FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print("outline guard OK — no outline suppressed without a :focus-visible replacement")


if __name__ == "__main__":
    main()
