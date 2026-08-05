#!/usr/bin/env python3
"""Post-deploy browser smoke for the Land project-connections contract."""

from __future__ import annotations

import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "https://cityscroll.org/").rstrip("/") + "/"
PROJECT_ID = os.environ.get("CROL_PROJECT_CONNECTIONS_ID", "2022M0258")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 960})
        page.goto(f"{BASE}#land/{PROJECT_ID}", wait_until="domcontentloaded", timeout=60_000)
        selector = (
            f'.project-connections[data-project-ref="project:{PROJECT_ID}"], '
            '[data-project-connections-state="unavailable"]'
        )
        page.wait_for_selector(selector, state="visible", timeout=60_000)
        available = page.locator(f'.project-connections[data-project-ref="project:{PROJECT_ID}"]')
        unavailable = page.locator('[data-project-connections-state="unavailable"]')
        if available.count():
            groups = available.locator(".pc-group").count()
            if groups != 5:
                raise AssertionError(f"project connections rendered {groups} groups; expected 5")
            print(f"project-connections browser smoke OK state=available groups={groups}")
        elif unavailable.count() and unavailable.inner_text().strip():
            print("project-connections browser smoke OK state=unavailable")
        else:
            raise AssertionError("project connections rendered neither data nor an honest unavailable state")
        browser.close()


if __name__ == "__main__":
    main()
