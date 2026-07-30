#!/usr/bin/env python3
"""Verify and capture the compact exam guide in collapsed and first-visit states."""
from __future__ import annotations

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "site" / "media" / "review" / "exam-polish"
VIEWPORTS = ((390, 844), (1440, 900))
STATES = ("collapsed", "expanded")
SEEN_KEY = "crol_exam_how_seen_v1"
MATTER_PINS = (
    "84124P0003001",
    "06820P8165KXLR002",
    "07124N0007001R001",
    "82626B0029001",
)

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    failures = []
    captures = []

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                for state in STATES:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    install_routes(page)
                    if state == "collapsed":
                        page.add_init_script(f"localStorage.setItem('{SEEN_KEY}', '1')")
                    page.goto(base + "#exam", wait_until="load")
                    page.locator("#career-results .career-card").first.wait_for(state="visible")
                    details = page.locator("#career-how-details")
                    expected_open = state == "expanded"
                    if details.evaluate("element => element.open") != expected_open:
                        failures.append(f"{width}px {state}: wrong explainer state")
                    if page.evaluate("location.hash") != "#people?view=guide":
                        failures.append(f"{width}px {state}: #exam did not canonicalize to the guide")
                    if state == "expanded" and page.evaluate(
                        f"localStorage.getItem('{SEEN_KEY}')"
                    ) != "1":
                        failures.append(f"{width}px expanded: first-visit flag was not stored")

                    facts = page.locator(".career-fact").evaluate_all(
                        "elements => elements.map(element => element.getBoundingClientRect().top)"
                    )
                    if max(facts) - min(facts) > 2:
                        failures.append(f"{width}px {state}: stats did not stay in one inline row")
                    intro_height = page.locator(".career-intro").evaluate(
                        "element => element.getBoundingClientRect().height"
                    )
                    if state == "collapsed" and intro_height > 160:
                        failures.append(
                            f"{width}px collapsed: compact intro is {intro_height:.1f}px tall"
                        )
                    overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                    if overflow > 1:
                        failures.append(f"{width}px {state}: horizontal overflow is {overflow}px")

                    if not args.verify_only:
                        OUTPUT.mkdir(parents=True, exist_ok=True)
                        target = OUTPUT / f"{state}-{width}.png"
                        intro_top = page.locator(".career-intro").evaluate(
                            "element => element.getBoundingClientRect().top + window.scrollY"
                        )
                        page.evaluate(
                            """top => {
                              document.documentElement.style.overflowAnchor = 'none';
                              document.body.style.overflowAnchor = 'none';
                              window.scrollTo({top, behavior: 'instant'});
                            }""",
                            intro_top,
                        )
                        page.wait_for_timeout(100)
                        page.screenshot(path=target, animations="disabled")
                        captures.append(str(target.relative_to(ROOT)))
                    context.close()

            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            install_routes(page)
            page.add_init_script(
                """Object.defineProperty(navigator, 'clipboard', {
                  value: {writeText: async value => { window.__copiedMatter = value; }}
                });"""
            )
            page.goto(base + "#money", wait_until="load")
            page.locator(".contract-examples").evaluate("element => element.open = true")
            links = page.locator(".contract-example a").evaluate_all(
                "elements => elements.map(element => element.getAttribute('href'))"
            )
            expected_links = [f"#matter/{pin}" for pin in MATTER_PINS]
            if links != expected_links:
                failures.append(f"contract examples differ: {links}")
            page.locator("[data-matter-copy]").first.click()
            copied = page.evaluate("window.__copiedMatter")
            if copied != base + "#matter/" + MATTER_PINS[0]:
                failures.append(f"copy control produced {copied!r}")

            route_destinations = {
                "notice": "#money",
                "exam": "#people?view=guide",
                "land": "#land",
                "vendor": "#money",
                "agency": "#money",
                "matter": "#money",
                "investigation/shared": "#investigation",
            }
            for route, destination in route_destinations.items():
                page.goto(base + "#" + route, wait_until="domcontentloaded")
                page.wait_for_function(
                    "destination => location.hash === destination", arg=destination
                )
                if page.evaluate("location.hash") != destination:
                    failures.append(f"#{route} did not land on {destination}")
            context.close()
            browser.close()
    finally:
        server.shutdown()

    result = {
        "viewports": [width for width, _ in VIEWPORTS],
        "states": list(STATES),
        "captures": captures,
        "failures": failures,
    }
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(1)
    print("Bare routes, compact exam states, sourced contract links, copy controls, and layout passed.")


if __name__ == "__main__":
    main()
