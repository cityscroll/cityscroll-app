"""The compatibility Places document route remains directly reachable."""

from __future__ import annotations

import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page()
    page.goto(f"{BASE}/browse/places/", wait_until="domcontentloaded")
    page.wait_for_function("location.pathname === '/browse/places/'")
    page.wait_for_selector('[data-browse-concept="places"] #community-boards')

    assert page.url.rstrip("/").endswith("/browse/places")
    concept = page.locator('[data-browse-concept="places"]')
    assert concept.locator("#community-boards").is_visible()
    assert concept.get_by_text("Bronx Community Board 1", exact=False).count() > 0
    assert concept.locator(".empty").count() == 0

    browser.close()
