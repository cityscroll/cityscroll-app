#!/usr/bin/env python3
"""Capture Near-you Records/Map discoverability at desktop and mobile widths."""

from __future__ import annotations

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "near-you-desktop-map"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


def serve() -> tuple[ThreadingHTTPServer, str]:
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


def surface_metrics(page: Page) -> dict[str, object]:
    return page.evaluate(
        """() => {
          const rect = selector => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const box = node.getBoundingClientRect();
            return {top: box.top + scrollY, height: box.height};
          };
          const switchNode = document.querySelector('[data-near-surface-switch]');
          return {
            document_height: document.documentElement.scrollHeight,
            viewport: {width: innerWidth, height: innerHeight},
            switch_display: switchNode ? getComputedStyle(switchNode).display : null,
            switch_rect: rect('[data-near-surface-switch]'),
            results_rect: rect('[data-near-surface-panel="list"]'),
            map_rect: rect('[data-near-surface-panel="map"]'),
            active_surface: document.querySelector('[data-near-you-root]')?.dataset.nearMobileSurface || null,
          };
        }"""
    )


def capture_desktop(page: Page, base: str, phase: str) -> dict[str, object]:
    page.goto(f"{base}/near-you/", wait_until="networkidle")
    page.locator("#near-results-heading").scroll_into_view_if_needed()
    page.screenshot(path=OUTPUT / f"{phase}-desktop-entry-1440.png", animations="disabled")
    metrics = surface_metrics(page)

    map_link = page.locator('[data-near-surface="map"]')
    if map_link.is_visible():
        map_link.click()
        page.locator("#near-map-heading").scroll_into_view_if_needed()
    else:
        page.locator("#near-map-heading").scroll_into_view_if_needed()
    page.screenshot(path=OUTPUT / f"{phase}-desktop-map-1440.png", animations="disabled")
    metrics["after_map_action"] = surface_metrics(page)
    return metrics


def capture_mobile(page: Page, base: str, phase: str) -> dict[str, object]:
    page.goto(f"{base}/near-you/", wait_until="networkidle")
    page.locator('[data-near-surface="map"]').click()
    page.locator("#near-map-heading").scroll_into_view_if_needed()
    page.screenshot(path=OUTPUT / f"{phase}-mobile-map-390.png", animations="disabled")
    return surface_metrics(page)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("before", "after"))
    args = parser.parse_args()

    OUTPUT.mkdir(parents=True, exist_ok=True)
    server, base = serve()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            desktop = browser.new_page(viewport={"width": 1440, "height": 1000})
            mobile = browser.new_page(viewport={"width": 390, "height": 844})
            metrics = {
                "phase": args.phase,
                "desktop": capture_desktop(desktop, base, args.phase),
                "mobile": capture_mobile(mobile, base, args.phase),
            }
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    metrics_path = OUTPUT / f"{args.phase}-metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n")
    print("wrote", metrics_path.relative_to(ROOT))


if __name__ == "__main__":
    main()
