#!/usr/bin/env python3
"""Capture matching public pages from the stable and beta deployments."""

from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
VIEWPORTS = ((390, 844), (1440, 900))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected", required=True)
    parser.add_argument("--actual", required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "docs" / "evidence" / "frontstage-root",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for label, url in (("stable", args.expected), ("beta", args.actual)):
            for width, height in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page.goto(url, wait_until="domcontentloaded")
                page.locator("main").first.wait_for(state="visible")
                page.screenshot(
                    path=args.output / f"{label}-{width}.png",
                    full_page=True,
                    animations="disabled",
                )
                page.close()
        browser.close()

    for path in sorted(args.output.glob("*.png")):
        print(f"{path.relative_to(ROOT)} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
