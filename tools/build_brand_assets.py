#!/usr/bin/env python3
"""Generate CityScroll raster icons and social media art from the SVG sources."""
from __future__ import annotations

from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "assets" / "brand"


def convert(source: str, target: str, size: str):
    subprocess.run(
        [
            "magick",
            "-background",
            "none",
            str(BRAND / source),
            "-resize",
            size,
            str(BRAND / target),
        ],
        check=True,
    )


def main():
    convert("cityscroll-app-icon.svg", "apple-touch-icon.png", "180x180")
    convert("cityscroll-app-icon.svg", "icon-192.png", "192x192")
    convert("cityscroll-app-icon.svg", "icon-512.png", "512x512")
    convert("favicon.svg", "favicon-32.png", "32x32")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
        page.goto((BRAND / "cityscroll-social-card.svg").as_uri(), wait_until="load")
        page.screenshot(
            path=BRAND / "cityscroll-social-card.png",
            animations="disabled",
        )
        browser.close()

    print("Generated CityScroll touch, manifest, favicon, and social-card PNG assets.")


if __name__ == "__main__":
    main()
