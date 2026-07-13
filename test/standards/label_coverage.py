#!/usr/bin/env python3
"""Label-coverage census gate (w7-04) — no field ships without a programmatic name.

Placeholder-only naming (WCAG 3.3.2/4.1.2) vanishes on input and isn't reliably exposed as
an accessible name. This is a rendered-DOM census (Playwright), not a static-source lint,
because several offending fields are hidden at load (behind an inactive .tabpane, or built
by JS only once a tab/panel is activated) — a static grep can't see them and axe itself
skips display:none nodes. Hermetic: no live network (test/functional/assets/i18n_fixtures.py
stubs every upstream), so it runs in CI on every PR.
"""
import json
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

INV_SEED = {"current": "inv1", "invs": {"inv1": {
    "name": "My investigation", "created": "2026-07-10",
    "items": [{"t": "agency", "id": "Housing Preservation and Development",
               "title": "Housing Preservation and Development (HPD)",
               "meta": "agency profile", "note": "", "added": "2026-07-12"}]}}}

CENSUS_JS = """() => {
  const els = [...document.querySelectorAll('input, select, textarea')];
  return els.filter(el => el.type !== 'hidden').map(el => {
    const hasFor = !!(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    const wrappingLabel = !!el.closest('label');
    const ariaLabel = !!(el.getAttribute('aria-label') || '').trim();
    const labelledbyIds = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
    const ariaLabelledby = labelledbyIds.length > 0 && labelledbyIds.every(id => document.getElementById(id));
    return {
      tag: el.tagName, id: el.id, type: el.type || '', cls: el.className,
      named: hasFor || wrappingLabel || ariaLabel || ariaLabelledby,
    };
  });
}"""


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def census(page, state_name, failures):
    fields = page.evaluate(CENSUS_JS)
    unnamed = [f for f in fields if not f["named"]]
    for f in unnamed:
        desc = f"{f['tag']}#{f['id'] or '(no id)'}"
        failures.append(f"{state_name}: {desc} has no programmatic name (no label[for]/"
                         "wrapping label/aria-label/aria-labelledby)")
    if not unnamed:
        step("OK", state_name, f"{len(fields)} field(s), all named")


def main():
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for path in PAGES:
            ctx = browser.new_context()
            if not path:
                ctx.add_init_script(
                    f"localStorage.setItem('crd_invs_v1', JSON.stringify({json.dumps(INV_SEED)}))")
            page = ctx.new_page()
            install_routes(page)
            page.goto(BASE + path, timeout=30000)
            page.wait_for_load_state("load", timeout=20000)
            page.wait_for_timeout(1200)
            name = path or "index.html"
            census(page, name, failures)

            if not path:  # index.html: walk every tab + the alerts digest preview + investigation
                for tab in TABS:
                    page.click(f'.tabbtn[data-tab="{tab}"]')
                    page.wait_for_timeout(400)
                    census(page, f"{name} [tab:{tab}]", failures)
                page.click("#apreview")
                page.wait_for_timeout(600)
                census(page, f"{name} [alerts:digest-preview]", failures)

                page.evaluate("location.hash = '#investigation'")
                page.wait_for_timeout(800)
                census(page, f"{name} [investigation-workspace]", failures)
            ctx.close()
        browser.close()

    if failures:
        print(f"label-coverage census FAILED — {len(failures)} unlabeled field(s):", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print("label-coverage census OK — every input/select/textarea has a programmatic name")


if __name__ == "__main__":
    main()
