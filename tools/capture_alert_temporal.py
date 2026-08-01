#!/usr/bin/env python3
"""Render the late-arriving Rules digest card from the production email renderer."""

from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "alert-temporal"


def main() -> None:
    rendered = subprocess.run(
        ["node", str(ROOT / "tools" / "render_alert_temporal_email.mjs")],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / "late-rules-comment-card.png"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 760, "height": 520}, device_scale_factor=1)
        page.set_content(rendered, wait_until="load")
        page.screenshot(path=str(target), full_page=True, animations="disabled")
        browser.close()
    print(target.relative_to(ROOT))


if __name__ == "__main__":
    main()
