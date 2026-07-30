#!/usr/bin/env python3
"""Capture public-site screenshots for the README.

Captures frames from the live cityscroll.org that each prove a cross-source
capability. All captures are headless Chromium against the public deployment.
Output: docs/readme/*.png
"""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://cityscroll.org/"
OUT = Path(__file__).resolve().parents[1] / "docs" / "readme"
WIDTH = 1440
HEIGHT = 900


def goto(page, hash_route: str | None = None, wait_ms: int = 8000) -> None:
    """Navigate to the site and optionally set a hash route, then wait for data."""
    page.goto(BASE, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_timeout(2000)
    if hash_route:
        page.evaluate(f"() => window.location.hash = '{hash_route}'")
        page.wait_for_timeout(wait_ms)


def capture_homepage(page) -> None:
    """Homepage task chooser — proves multi-domain aggregation."""
    goto(page, wait_ms=6000)
    page.screenshot(path=str(OUT / "homepage.png"), animations="disabled")


def capture_procurement_lifecycle(page) -> None:
    """Notice detail with procurement lifecycle — City Record + Checkbook + PASSPort + OCP joined."""
    goto(page)
    page.click('a[href="#notice/20260724018"]')
    page.wait_for_timeout(12_000)
    page.evaluate("() => window.scrollTo(0, 350)")
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "procurement-lifecycle.png"), animations="disabled")


def capture_vendor_profile(page) -> None:
    """Vendor profile — name variants resolved, all agencies, total awards across systems."""
    goto(page, "#vendor/Community%20Mediation%20Services%2C%20Inc.", wait_ms=15_000)
    page.screenshot(path=str(OUT / "vendor-profile.png"), animations="disabled")


def capture_data_page(page) -> None:
    """Data page — live per-section counting and transparency about data quality."""
    page.goto(f"{BASE}data.html", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_timeout(10_000)
    page.screenshot(path=str(OUT / "data-page.png"), animations="disabled")


def capture_money_search(page) -> None:
    """Money lens with procurement notices — RFPs and awards in one searchable view."""
    goto(page)
    page.click('[data-tab="money"]')
    page.wait_for_timeout(8000)
    page.evaluate("() => window.scrollTo(0, 1100)")
    page.wait_for_timeout(3000)
    page.screenshot(path=str(OUT / "money-search.png"), animations="disabled")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page(
                viewport={"width": WIDTH, "height": HEIGHT},
                device_scale_factor=2,
            )

            capture_homepage(page)
            print(f"captured {OUT / 'homepage.png'}")

            capture_procurement_lifecycle(page)
            print(f"captured {OUT / 'procurement-lifecycle.png'}")

            capture_vendor_profile(page)
            print(f"captured {OUT / 'vendor-profile.png'}")

            capture_data_page(page)
            print(f"captured {OUT / 'data-page.png'}")

            capture_money_search(page)
            print(f"captured {OUT / 'money-search.png'}")

            page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
