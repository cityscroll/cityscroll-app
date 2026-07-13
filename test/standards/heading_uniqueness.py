#!/usr/bin/env python3
"""Heading-uniqueness + landmark check per rendered state (w7-05).

Two h2 "Listing" headings exist on index.html (people/land tabs) — never visible
simultaneously today, so screen-reader heading navigation stays unambiguous, but nothing
guarded that invariant. This is a rendered-DOM check (Playwright), scoped to VISIBLE
headings per state — a global "no duplicate heading text in the DOM" check would wrongly
flag headings that legitimately share text while their tabs are mutually exclusive.
Also asserts exactly one visible h1 and one <main> landmark per state (retiring the
standing axe 'landmark-one-main'/'region' moderates over time). Hermetic: no live network.
"""
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
PAGES = ["", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]
TABS = ["people", "land", "property", "rules", "meetings", "alerts"]

STATE_JS = """() => {
  function visible(el){
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible)
    .map(el => ({tag: el.tagName, text: el.textContent.replace(/\\s+/g,' ').trim()}));
  const mains = [...document.querySelectorAll('main')].filter(visible);
  return {headings, h1Count: headings.filter(h => h.tag === 'H1').length, mainCount: mains.length};
}"""


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def check_state(page, state_name, failures):
    state = page.evaluate(STATE_JS)
    texts = [h["text"] for h in state["headings"] if h["text"]]
    dupes = sorted({t for t in texts if texts.count(t) > 1})
    if dupes:
        failures.append(f"{state_name}: duplicate visible heading text: {dupes}")
    if state["h1Count"] != 1:
        failures.append(f"{state_name}: expected exactly 1 visible h1, found {state['h1Count']}")
    if state["mainCount"] != 1:
        failures.append(f"{state_name}: expected exactly 1 main landmark, found {state['mainCount']}")
    if not dupes and state["h1Count"] == 1 and state["mainCount"] == 1:
        step("OK", state_name, f"{len(texts)} unique heading(s), 1 h1, 1 main")


def main():
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for path in PAGES:
            ctx = browser.new_context()
            page = ctx.new_page()
            install_routes(page)
            page.goto(BASE + path, timeout=30000)
            page.wait_for_load_state("load", timeout=20000)
            page.wait_for_timeout(1200)
            name = path or "index.html"
            check_state(page, name, failures)

            if not path:
                for tab in TABS:
                    page.click(f'.tabbtn[data-tab="{tab}"]')
                    page.wait_for_timeout(400)
                    check_state(page, f"{name} [tab:{tab}]", failures)
            ctx.close()
        browser.close()

    if failures:
        print(f"heading-uniqueness gate FAILED — {len(failures)} issue(s):", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print("heading-uniqueness gate OK — unique visible headings, 1 h1 + 1 main per rendered state")


if __name__ == "__main__":
    main()
