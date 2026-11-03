#!/usr/bin/env python3
"""Heading-uniqueness + landmark check per rendered state (w7-05).

Two h2 "Listing" headings exist on index.html (people/land tabs) — never visible
simultaneously today, so screen-reader heading navigation stays unambiguous, but nothing
guarded that invariant. This is a rendered-DOM check (Playwright), scoped to VISIBLE
headings per state — a global "no duplicate heading text in the DOM" check would wrongly
flag headings that legitimately share text while their tabs are mutually exclusive.
Also asserts exactly one visible h1 and one <main> landmark per state (retiring the
standing axe 'landmark-one-main'/'region' moderates over time). Hermetic: no live network.

Several catalog entries are document handoffs that call location.replace (immediate or
deferred). Evaluating after the first load alone races that second navigation and raises
"Execution context was destroyed". open_rendered_page waits for the destination URL the
handoff actually performs, then evaluates once — no evaluate retries or fixed sleeps.
"""
import argparse
import http.server
import os
import pathlib
import socketserver
import sys
import threading
from urllib.parse import urlparse

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

# Client-side location.replace handoffs (see site/data.html delay, changelog/standards).
# Values are Playwright wait_for_url globs for the destination document.
DOCUMENT_HANDOFFS = {
    "data.html": "**/api.html**",
    "changelog.html": "**/about.html**",
    "standards.html": "**/about.html**",
}

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


def document_path(url):
    """Path of a URL without a trailing slash, for same-document comparisons."""
    path = urlparse(url).path or "/"
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    return path


def wait_for_load_settled(page, *, timeout_ms=10000):
    """Wait for the current document's load pipeline without assuming a full load event."""
    page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    try:
        page.wait_for_load_state("load", timeout=min(timeout_ms, 5000))
    except PlaywrightError:
        # Hash/SPA updates may never re-fire a full load event.
        pass


def open_rendered_page(page, path, *, timeout_ms=30000):
    """Goto path and wait through any client-side document handoff it performs."""
    page.goto(BASE + path, wait_until="domcontentloaded", timeout=timeout_ms)
    handoff = DOCUMENT_HANDOFFS.get(path)
    if handoff:
        page.wait_for_url(handoff, wait_until="domcontentloaded", timeout=timeout_ms)
    wait_for_load_settled(page, timeout_ms=timeout_ms)


def evaluate_state(page):
    """Read visible heading/landmark state from the settled document."""
    return page.evaluate(STATE_JS)


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
    before = document_path(page.url)
    page.click(selector)
    # Civic-object tabs often replace the document (e.g. /browse/people/). When the
    # path changes, wait for that document's load before reading headings.
    try:
        page.wait_for_function(
            """(beforePath) => {
              const path = (location.pathname || '/').replace(/\\/$/, '') || '/';
              const normalized = beforePath.replace(/\\/$/, '') || '/';
              return path !== normalized && document.readyState !== 'loading';
            }""",
            arg=before,
            timeout=3000,
        )
        wait_for_load_settled(page)
    except PlaywrightError:
        # Same-document tab switch: path stayed put.
        pass
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


def _old_load_only_then_overlap_evaluate(page, url):
    """Pre-fix waiting: first-document load, then an evaluate that straddles a deferred replace.

    Used only by the regression self-test to prove the race is deterministic.
    """
    overlap_js = """() => new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        void document.title;
        if (performance.now() - start > 1500) resolve({url: location.href});
        else setTimeout(tick, 25);
      };
      tick();
    })"""
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_load_state("load", timeout=20000)
    return page.evaluate(overlap_js)


def _new_wait_for_destination_then_evaluate(page, url, destination_glob):
    """Fixed waiting: wait for the handoff destination, then evaluate once."""
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_url(destination_glob, wait_until="domcontentloaded", timeout=10000)
    wait_for_load_settled(page, timeout_ms=10000)
    return page.evaluate(STATE_JS)


def run_navigation_regression():
    """Fail when load-only waiting still races a deferred location.replace; pass with destination wait."""
    fixture = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Handoff fixture</title>
<script>
  setTimeout(function () {
    location.replace(new URL("destination.html", location.href).toString());
  }, 1200);
</script>
</head>
<body><main><h1>Handoff source</h1></main></body></html>
"""
    destination = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Destination</title></head>
<body><main><h1>Handoff destination</h1><h2>Unique section</h2></main></body></html>
"""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path.split("?", 1)[0] in ("/", "/handoff.html"):
                body = fixture.encode("utf-8")
            elif self.path.split("?", 1)[0] == "/destination.html":
                body = destination.encode("utf-8")
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):  # noqa: A003
            return

    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{port}/"
        handoff_url = base + "handoff.html"
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                old_page = browser.new_page()
                old_failed = False
                try:
                    _old_load_only_then_overlap_evaluate(old_page, handoff_url)
                except PlaywrightError as err:
                    msg = str(err)
                    if "Execution context was destroyed" in msg or "navigation" in msg:
                        old_failed = True
                    else:
                        raise
                finally:
                    old_page.close()
                if not old_failed:
                    raise SystemExit(
                        "heading-uniqueness navigation regression FAILED — "
                        "old load-only wait did not raise under deferred location.replace"
                    )

                new_page = browser.new_page()
                try:
                    state = _new_wait_for_destination_then_evaluate(
                        new_page, handoff_url, "**/destination.html"
                    )
                finally:
                    new_page.close()
                browser.close()

                if state["h1Count"] != 1 or state["mainCount"] != 1:
                    raise SystemExit(
                        "heading-uniqueness navigation regression FAILED — "
                        f"destination state not unique/landmark-correct: {state!r}"
                    )
                texts = [h["text"] for h in state["headings"] if h["text"]]
                if len(texts) != len(set(texts)):
                    raise SystemExit(
                        "heading-uniqueness navigation regression FAILED — "
                        f"destination headings not unique: {texts!r}"
                    )
        finally:
            httpd.shutdown()

    step("OK", "navigation-regression", "old load-only wait fails; destination wait passes")
    print("heading-uniqueness navigation regression OK")


def main():
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for path in PAGES:
            ctx = browser.new_context()
            page = ctx.new_page()
            install_routes(page)
            open_rendered_page(page, path, timeout_ms=30000)
            name = path or "index.html"
            if path in DOCUMENT_HANDOFFS:
                name = f"{path} (via handoff)"
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run only the deferred-navigation regression (old wait fails, new wait passes).",
    )
    args = parser.parse_args()
    if args.self_test:
        run_navigation_regression()
    else:
        run_navigation_regression()
        main()
