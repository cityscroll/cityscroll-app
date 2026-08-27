#!/usr/bin/env python3
"""Capture before/after Meetings Browse evidence at desktop and mobile sizes."""

from __future__ import annotations

import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "calendar-subscription-affordance"
VIEWPORTS = ((390, 844, "mobile"), (1440, 900, "desktop"))
ROUTE = "/browse/meetings/"


def assert_no_horizontal_overflow(page) -> None:
    assert page.evaluate("""() => [...document.querySelectorAll('body *')].every((element) => {
        if (element.matches('.skip') || getComputedStyle(element).display === 'none') return true;
        const rect = element.getBoundingClientRect();
        return rect.right <= window.innerWidth + 1 && rect.left >= -1;
    })"""), (
        f"horizontal overflow at {page.viewport_size['width']}px"
    )


def capture(browser, base: str, phase: str) -> None:
    for width, height, name in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        page.goto(f"{base.rstrip('/')}{ROUTE}", wait_until="networkidle", timeout=45_000)
        control = page.locator('a[data-calendar-subscribe-lens="meetings"]')
        if phase == "after":
            control.wait_for(state="visible", timeout=20_000)
            assert control.inner_text() == "Subscribe to calendar"
        else:
            assert control.count() == 0
        page.locator("#meetings-toolbar").scroll_into_view_if_needed()
        assert_no_horizontal_overflow(page)
        page.screenshot(
            path=str(OUT / f"{phase}-{name}.png"),
            animations="disabled",
        )
        page.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cityscroll-calendar-capture-") as temp:
        ready = Path(temp) / "ready.txt"
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
