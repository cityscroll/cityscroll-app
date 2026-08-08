#!/usr/bin/env python3
"""Fail when implementation-facing snake_case vocabulary reaches rendered copy.

This is a rendered-DOM census because route-driven and tab-driven surfaces are built by
JavaScript. ``innerText`` deliberately limits the check to reader-visible copy: data
attributes, accessible provenance, and maintainer hover text are not public body copy.
"""

import os
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

# Source: the local server contract used by the repository's browser CI job.
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/")
PAGES = ["", "about.html", "data.html", "stats.html", "api.html", "changelog.html", "standards.html", "near-you/index.html", "following/index.html"]  # Source: public page inventory in the reading-level and metadata gates.
TABS = ["money", "people", "land", "property", "rules", "meetings"]  # Source: site/index.html .tabbtn[data-tab] controls.
SNAKE_CASE = re.compile(r"\b[a-z]+(?:_[a-z0-9]+)+\b")

# Keep this narrow and evidence-backed. Add an entry only when underscores are genuinely
# reader-facing language rather than an internal field, enum, or identifier.
ALLOWLIST = frozenset({
    # The API reference intentionally presents exact route parameters, response fields,
    # and MCP tool names as code. Their spelling is the contract readers need to call.
    "agency_name", "canonical_id", "canonical_name", "create_watch", "get_notice",
    "preview_watch", "raw_string", "request_id", "search_notices",
})


def visible_text(page):
    return page.locator("body").inner_text()


def census(page, state, failures):
    matches = sorted(set(SNAKE_CASE.findall(visible_text(page))) - ALLOWLIST)
    if matches:
        failures.append((state, matches))
    else:
        print(f"OK {state}", flush=True)


def main():
    failures = []  # Findings derived by census() during this run.
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for path in PAGES:
            context = browser.new_context()
            page = context.new_page()
            install_routes(page)
            page.goto(BASE + path, timeout=30_000)
            page.wait_for_load_state("load", timeout=20_000)
            page.wait_for_timeout(800)
            name = path or "index.html"
            census(page, name, failures)

            if not path:
                for tab in TABS:
                    page.click(f'.tabbtn[data-tab="{tab}"]')
                    page.wait_for_timeout(400)
                    census(page, f"{name} [tab:{tab}]", failures)

                page.click('.tabbtn[data-tab="money"]')
                page.locator("#list .row").first.click()
                page.wait_for_timeout(600)
                census(page, f"{name} [money:notice-detail]", failures)

                page.evaluate("location.hash = '#agency/Housing Preservation and Development'")
                page.wait_for_timeout(800)
                census(page, f"{name} [entity:agency]", failures)
                # Agency hash may forward to a static constellation document; SPA
                # states below need the shell again.
                page.goto(BASE, wait_until="load", timeout=30_000)
                page.wait_for_timeout(400)

                for task_hash, task_name in (
                    ("#task/can-i-bid", "task:can-i-bid"),
                    ("#task/what-will-change", "task:what-will-change"),
                ):
                    page.evaluate("hash => { location.hash = hash; }", task_hash)
                    page.locator(".task-first .task-card").first.wait_for(timeout=15_000)
                    census(page, f"{name} [{task_name}]", failures)

                page.evaluate("location.hash = '#now'")
                page.locator(".now-surface").wait_for(timeout=20_000)
                census(page, f"{name} [route:now]", failures)

                page.evaluate("location.hash = '#investigation'")
                page.wait_for_timeout(800)
                census(page, f"{name} [route:investigation]", failures)
            context.close()
        browser.close()

    if failures:
        print(f"rendered schema-vocabulary census FAILED — {len(failures)} surface(s):", file=sys.stderr)
        for state, matches in failures:
            print(f"  {state}: {', '.join(matches)}", file=sys.stderr)
        return 1
    print("rendered schema-vocabulary census OK — no snake_case identifiers in visible copy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
