#!/usr/bin/env python3
"""Capture live-before and local-after Browse facet controls at 390px and 1440px."""

from __future__ import annotations

import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "browse-facet-controls"
VIEWPORTS = ((390, 844), (1440, 1000))
ROUTES = (("staffing", "/browse/staffing/", ".career-browser"), ("rules", "/browse/rules/", "#tab-rules .wrap"))


def capture(browser, base: str, phase: str) -> None:
    for name, route, selector in ROUTES:
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
            page.goto(f"{base.rstrip('/')}{route}", wait_until="domcontentloaded", timeout=45_000)
            page.wait_for_selector(selector, timeout=20_000)
            if name == "rules" and page.locator(".filtertoggle").is_visible():
                page.locator(".filtertoggle").click()
            if phase == "after":
                if name == "staffing":
                    page.wait_for_selector("#career-eligibility-facets button", timeout=20_000)
                else:
                    page.wait_for_selector('[data-cardinality-facet="large"] .facet-typeahead-input', state="attached", timeout=20_000)
            page.locator(selector).screenshot(
                path=str(OUT / f"{phase}-{name}-{width}.png"), animations="disabled"
            )
            page.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-browse-capture-") as temp:
        ready = Path(temp) / "ready.json"
        server = subprocess.Popen([
            "python3", str(ROOT / "tools" / "local_site_server.py"),
            "--directory", str(ROOT / "site"), "--port", "0", "--ready-file", str(ready),
        ])
        try:
            for _ in range(100):
                if ready.exists():
                    break
                time.sleep(0.05)
            local = ready.read_text(encoding="utf-8").strip()
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                capture(browser, "https://cityscroll.org", "before")
                capture(browser, local, "after")
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=10)
    print(f"wrote screenshots under {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
