"""Regression: Near You map wait uses the page settle signal, not a timing guess.

The browser-a11y mobile-viewport check flaked when it opened the Areas directory
before enhanced map init rewrote `#near-area-list`, leaving the first area link
hidden forever. This focused proof:

1. Delays the simplified NTA layer so map settle is observably slow, then shows
   `wait_for_near_you_geography_map` still reaches ready and the directory opens.
2. Aborts that layer forever and shows the same wait still fails (positive
   control) instead of treating a never-ready map as success.
"""

from __future__ import annotations

import functools
import http.server
import os
from pathlib import Path
import sys
import threading
import time

from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from ci_waits import wait_for_locator, wait_for_near_you_geography_map  # noqa: E402
from tools.local_site_server import QuietHandler  # noqa: E402
from fixture_clock import pin_fixture_clock  # noqa: E402

BASE = os.environ.get("CROL_BASE", "")
NEAR_YOU_ROUTE = "near-you/"
LAYER_GLOB = "**/data/geography/layers/nta2020/**"
SLOW_LAYER_DELAY_MS = 2_500
NEVER_READY_TIMEOUT_MS = 2_500


def open_near_you_directory_list(page) -> None:
    disclosure = page.locator("[data-geography-directory-list] > summary")
    if disclosure.count() == 0:
        return
    details = page.locator("[data-geography-directory-list]")
    if details.count() > 0 and details.first.get_attribute("open") is not None:
        return
    disclosure.first.click()
    page.wait_for_function(
        """() => Boolean(document.querySelector("[data-geography-directory-list]")?.open)""",
        timeout=15_000,
    )


def install_layer_route(page, *, delay_ms: int = 0, hang: bool = False) -> None:
    def handler(route: Route) -> None:
        if hang:
            # Hold past the never-ready wait, then abort so Playwright does not
            # cancel an unresolved route handler when the page closes.
            time.sleep((NEVER_READY_TIMEOUT_MS + 1_500) / 1000)
            try:
                route.abort("timedout")
            except Exception:
                pass
            return
        if delay_ms > 0:
            time.sleep(delay_ms / 1000)
        route.continue_()

    page.route(LAYER_GLOB, handler)


def wait_for_near_you_enhanced(page, *, label: str) -> None:
    wait_for_locator(
        page.locator("#near-geo-heading, [data-near-surface='map'], .near-geo-workspace").first,
        label=label,
    )
    page.wait_for_function(
        """() => document.querySelector("[data-near-you-root]")?.dataset.enhanced === "true" """,
        timeout=45_000,
    )


def assert_slow_map_wait_then_directory(page, base: str) -> None:
    install_layer_route(page, delay_ms=SLOW_LAYER_DELAY_MS)
    page.goto(f"{base}{NEAR_YOU_ROUTE}", wait_until="domcontentloaded", timeout=30_000)
    wait_for_near_you_enhanced(page, label="Near you mobile surface")
    # Scripting has enhanced the shell, but the delayed layer keeps settle on
    # loading. The wait must stay pending until data-near-geography-map-state
    # becomes ready with a layer count.
    early = page.evaluate(
        """() => ({
          enhanced: document.querySelector('[data-near-you-root]')?.dataset.enhanced || null,
          state: document.querySelector('[data-near-you-root]')?.dataset.nearGeographyMapState || null,
        })"""
    )
    assert early["enhanced"] == "true", early
    assert early["state"] in {None, "", "loading"}, early

    started = time.monotonic()
    wait_for_near_you_geography_map(page, attempts=1)
    elapsed_ms = (time.monotonic() - started) * 1000
    assert elapsed_ms >= SLOW_LAYER_DELAY_MS * 0.6, (
        f"settle wait returned too quickly ({elapsed_ms:.0f}ms) to have observed the slow layer"
    )

    settled = page.evaluate(
        """() => ({
          state: document.querySelector('[data-near-you-root]')?.dataset.nearGeographyMapState || null,
          layerCount: Number(document.querySelector('[data-near-you-root]')?.dataset.nearGeographyLayerCount || 0),
        })"""
    )
    assert settled["state"] == "ready", settled
    assert settled["layerCount"] > 0, settled

    open_near_you_directory_list(page)
    wait_for_locator(
        page.locator(".near-area-list a").first,
        label="Near you map area link after slow map",
        attempts=1,
    )


def assert_never_ready_map_wait_fails(page, base: str) -> None:
    install_layer_route(page, hang=True)
    page.goto(f"{base}{NEAR_YOU_ROUTE}", wait_until="domcontentloaded", timeout=30_000)
    wait_for_near_you_enhanced(page, label="Near you mobile surface before never-ready wait")
    try:
        wait_for_near_you_geography_map(
            page,
            timeout=NEVER_READY_TIMEOUT_MS,
            attempts=1,
            label="Near you geography map never ready",
        )
    except PlaywrightTimeoutError:
        state = page.evaluate(
            """() => document.querySelector('[data-near-you-root]')?.dataset.nearGeographyMapState || null"""
        )
        # A hung layer must remain unsettled; ready would weaken the control.
        assert state != "ready", state
        return
    raise AssertionError("never-ready map wait returned success; expected a timeout failure")


def run(base: str) -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        slow = browser.new_context(viewport={"width": 360, "height": 780}, has_touch=True)
        pin_fixture_clock(slow)
        slow_page = slow.new_page()
        assert_slow_map_wait_then_directory(slow_page, base)
        slow.close()

        never = browser.new_context(viewport={"width": 360, "height": 780}, has_touch=True)
        pin_fixture_clock(never)
        never_page = never.new_page()
        assert_never_ready_map_wait_fails(never_page, base)
        never.close()

        browser.close()


def main() -> None:
    global BASE
    server = None
    thread = None
    try:
        if not BASE:
            handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            BASE = f"http://127.0.0.1:{server.server_port}/"
        run(BASE)
        print("OK near-you map wait: slow settle succeeds; never-ready still fails")
    finally:
        if server:
            server.shutdown()
            if thread:
                thread.join(timeout=5)
            server.server_close()


if __name__ == "__main__":
    main()
