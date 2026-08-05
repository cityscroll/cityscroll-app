#!/usr/bin/env python3
"""Capture the reported Property default feed before and after lifecycle parity."""

from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import time

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "property-action-tense"
PRODUCTION = "https://cityscroll.org/browse/property/"


def wait_for_ready(path: Path, process: subprocess.Popen[str]) -> str:
    for _ in range(100):
        if path.exists() and path.read_text(encoding="utf-8").strip():
            return path.read_text(encoding="utf-8").strip()
        if process.poll() is not None:
            raise RuntimeError(f"local server exited with status {process.returncode}")
        time.sleep(0.05)
    raise RuntimeError("local server did not report its allocated port")


def wait_for_property(page: Page) -> None:
    page.wait_for_function(
        """() => {
          const feed = document.querySelector('#propertyfeed');
          const switcher = document.querySelector('[data-property-view=default]');
          return feed && switcher && !feed.querySelector('.skel');
        }""",
        timeout=45_000,
    )


def screenshot_surface(page: Page, target: Path, selector: str = "#tab-property") -> None:
    page.locator(selector).first.evaluate("element => element.scrollIntoView({block: 'start'})")
    page.screenshot(path=str(target), animations="disabled", full_page=False)


def capture_before(page: Page, suffix: str) -> None:
    page.goto(PRODUCTION, wait_until="domcontentloaded")
    wait_for_property(page)
    text = page.locator("#propertyfeed").inner_text()
    assert "Past / decided" in text, "reported past-card wall was not reproduced"
    assert "you can send a bid" in text.lower(), "reported present-tense bid copy was not reproduced"
    screenshot_surface(page, OUT / f"before-default-{suffix}.png")


def capture_after(page: Page, base: str, suffix: str) -> None:
    page.goto(f"{base}browse/property/", wait_until="domcontentloaded")
    wait_for_property(page)
    current = page.locator('[data-property-view="default"] .ct').inner_text()
    closed = page.locator('[data-property-view="archive"] .ct').inner_text()
    feed = page.locator("#propertyfeed")
    assert feed.locator('.property-fcard[data-closed="1"]').count() == 0
    if int(current) == 0:
        text = feed.inner_text()
        assert "No open sales or participatory property notices right now" in text
        assert int(closed) > 0
    screenshot_surface(page, OUT / f"after-default-{suffix}.png")

    page.locator('[data-property-view="archive"]').click()
    page.wait_for_function(
        "document.querySelector('[data-property-view=archive]')?.getAttribute('aria-pressed') === 'true'",
    )
    page.wait_for_selector('#propertyfeed .property-fcard[data-closed="1"]')
    archive_text = feed.inner_text().lower()
    assert "you can send a bid" not in archive_text
    assert "you can send a proposal" not in archive_text
    assert feed.locator('[data-action-enabling-info][data-lifecycle="live"]').count() == 0
    assert feed.locator('[data-action-enabling-info][data-lifecycle="closed"]').count() > 0
    screenshot_surface(page, OUT / f"after-archive-{suffix}.png", '.property-fcard:has([data-action-enabling-info="1"])')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-property-action-") as temp:
        ready = Path(temp) / "ready.txt"
        process = subprocess.Popen(
            [
                "python3",
                str(ROOT / "tools" / "local_site_server.py"),
                "--directory",
                str(ROOT / "site"),
                "--port",
                "0",
                "--ready-file",
                str(ready),
            ],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            base = wait_for_ready(ready, process)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                for width, height, suffix in [(1440, 1200, "1440"), (390, 844, "390")]:
                    page = browser.new_page(viewport={"width": width, "height": height})
                    capture_before(page, suffix)
                    capture_after(page, base, suffix)
                    page.close()
                browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
    print(f"wrote before/after screenshots under {OUT}")


if __name__ == "__main__":
    main()
