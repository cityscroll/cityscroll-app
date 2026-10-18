#!/usr/bin/env python3
"""Heading-uniqueness + landmark check per rendered state (w7-05).

Two h2 "Listing" headings exist on index.html (people/land tabs) — never visible
simultaneously today, so screen-reader heading navigation stays unambiguous, but nothing
guarded that invariant. This is a rendered-DOM check (Playwright), scoped to VISIBLE
headings per state — a global "no duplicate heading text in the DOM" check would wrongly
flag headings that legitimately share text while their tabs are mutually exclusive.
Also asserts exactly one visible h1 and one <main> landmark per state (retiring the
standing axe 'landmark-one-main'/'region' moderates over time). Hermetic: no live network.

cs-heading-uniqueness-nav-race: after a tab click, SPA navigation can destroy the
execution context between wait_for_function and evaluate. Wait for a stable URL +
load state, then retry evaluate on context-destroyed — never drop heading/h1/main
assertions.
"""
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
        # Some SPA tab switches never re-fire full load; domcontentloaded is enough.
        pass
    # URL string access forces a post-navigation frame binding.
    _ = page.url


def evaluate_state(page, *, retries=3, timeout_ms=10000):
    """Evaluate STATE_JS with bounded retries on navigation context destruction."""
    last_err = None
    for attempt in range(retries):
        try:
            wait_for_stable_document(page, timeout_ms=timeout_ms)
            return page.evaluate(STATE_JS)
        except PlaywrightError as err:
            last_err = err
            if not _is_context_destroyed(err) or attempt + 1 >= retries:
                raise
            # Brief backoff so the next document can bind before re-evaluate.
            time.sleep(0.05 * (attempt + 1))
            wait_for_stable_document(page, timeout_ms=timeout_ms)
    raise last_err


def check_state(page, state_name, failures):
    state = evaluate_state(page)
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


def activate_tab(page, selector):
    page.click(selector)
    page.wait_for_selector("main h1, h1", timeout=10000)
    page.wait_for_function(
        """() => {
          const h1 = [...document.querySelectorAll('h1')].find((el) => {
            if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const main = [...document.querySelectorAll('main')].find((el) => {
            if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          return Boolean(h1 && main);
        }""",
        timeout=10000,
    )
    wait_for_stable_document(page)


def main():
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for path in PAGES:
            ctx = browser.new_context()
            page = ctx.new_page()
            install_routes(page)
            page.goto(BASE + path, timeout=30000)
            wait_for_stable_document(page, timeout_ms=20000)
            page.wait_for_timeout(1200)
            name = path or "index.html"
            check_state(page, name, failures)

            if path in ("", "index.html"):
                for tab, selector in TABS:
                    activate_tab(page, selector)
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
