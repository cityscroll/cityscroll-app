#!/usr/bin/env python3
"""Label-coverage census gate (w7-04) — no field ships without a programmatic name.

Placeholder-only naming (WCAG 3.3.2/4.1.2) vanishes on input and isn't reliably exposed as
an accessible name. This is a rendered-DOM census (Playwright), not a static-source lint,
because several offending fields are hidden at load (behind an inactive .tabpane, or built
by JS only once a tab/panel is activated) — a static grep can't see them and axe itself
skips display:none nodes. Hermetic: no live network (test/functional/assets/i18n_fixtures.py
stubs every upstream), so it runs in CI on every PR.

cs-label-coverage-flake / same class as cs-heading-uniqueness-nav-race: after goto or a
tab/hash transition, SPA navigation can destroy the execution context between the settle
wait and page.evaluate(CENSUS_JS). Wait for a stable URL + load state, then retry evaluate
on context-destroyed — never drop the unlabeled-field assertions.
"""
import json
import os
import pathlib
import sys
import time

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
# Site root `/` is the Near You shell; the topic SPA (civic-object tabs) is index.html.
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html", "standards.html", "near-you/index.html", "following/index.html"]  # Source: public site/ pages.
TABS = [
    ("people", '.tabbtn[data-tab="people"]'),
    ("land", '.tabbtn[data-tab="land"]'),
    ("property", '.tabbtn[data-route-facets~="property"]'),
    ("rules", '.tabbtn[data-tab="rules"]'),
    ("meetings", '.tabbtn[data-tab="meetings"]'),
]  # Source: site/index.html civic-object tabs and route facets.

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

CONTEXT_DESTROYED_MARKERS = (
    "Execution context was destroyed",
    "Cannot find context with specified id",
    "most likely because of a navigation",
)


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def _is_context_destroyed(err):
    msg = str(err)
    return any(marker in msg for marker in CONTEXT_DESTROYED_MARKERS)


def wait_for_stable_document(page, *, timeout_ms=10000):
    """Wait until navigation/load settles so evaluate is not racing a destroy."""
    page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    try:
        page.wait_for_load_state("load", timeout=min(timeout_ms, 5000))
    except PlaywrightError:
        # Some SPA tab/hash switches never re-fire full load; domcontentloaded is enough.
        pass
    # URL string access forces a post-navigation frame binding.
    _ = page.url


def evaluate_census(page, *, retries=3, timeout_ms=10000):
    """Evaluate CENSUS_JS with bounded retries on navigation context destruction."""
    last_err = None
    for attempt in range(retries):
        try:
            wait_for_stable_document(page, timeout_ms=timeout_ms)
            return page.evaluate(CENSUS_JS)
        except PlaywrightError as err:
            last_err = err
            if not _is_context_destroyed(err) or attempt + 1 >= retries:
                raise
            time.sleep(0.05 * (attempt + 1))
            wait_for_stable_document(page, timeout_ms=timeout_ms)
    raise last_err


def census(page, state_name, failures):
    fields = evaluate_census(page)
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
            if path in ("", "index.html"):
                ctx.add_init_script(
                    f"localStorage.setItem('crd_invs_v1', JSON.stringify({json.dumps(INV_SEED)}))")
            page = ctx.new_page()
            install_routes(page)
            page.goto(BASE + path, timeout=30000)
            wait_for_stable_document(page, timeout_ms=20000)
            page.wait_for_timeout(1200)
            name = path or "index.html"
            census(page, name, failures)

            if path in ("", "index.html"):  # topic SPA: walk every source tab plus the investigation route
                for tab, selector in TABS:
                    page.click(selector)
                    wait_for_stable_document(page)
                    page.wait_for_timeout(400)
                    census(page, f"{name} [tab:{tab}]", failures)
                page.evaluate("location.hash = '#investigation'")
                wait_for_stable_document(page)
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
