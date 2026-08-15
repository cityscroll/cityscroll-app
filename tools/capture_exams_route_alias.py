#!/usr/bin/env python3
"""Capture the public Exams route before and the generated alias after."""

from __future__ import annotations

import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "screenshots" / "exams-route-alias"


def ready_base(ready: Path) -> str:
    for _ in range(100):
        if ready.exists():
            return ready.read_text(encoding="utf-8").strip()
        time.sleep(0.05)
    raise RuntimeError("local site server did not publish a ready URL")


def capture(browser, base: str, phase: str) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    page.goto(f"{base.rstrip('/')}/browse/exams/", wait_until="domcontentloaded", timeout=45_000)
    page.wait_for_selector("#main", timeout=30_000)
    if phase == "after":
        page.wait_for_selector("#career-guide", timeout=30_000)
    page.screenshot(path=str(OUT / f"{phase}.png"), full_page=True, animations="disabled")
    page.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-exams-route-alias-") as temp:
        ready = Path(temp) / "ready.txt"
        server = subprocess.Popen([
            "python3", str(ROOT / "tools" / "local_site_server.py"),
            "--directory", str(ROOT / "site"), "--port", "0", "--ready-file", str(ready),
        ])
        try:
            local = ready_base(ready)
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
