#!/usr/bin/env python3
"""Capture the Contracts lens template at desktop and mobile widths."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "contracts-lens-template"


def load_performance_helpers():
    path = ROOT / "test" / "performance" / "verify.py"
    spec = importlib.util.spec_from_file_location("performance_verify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    verify = load_performance_helpers()
    fixture = json.loads(
        (ROOT / "test" / "performance" / "fixtures" / "contracts.keyword-housing.json").read_text()
    )
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with verify.StaticServer(ROOT / "site") as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in ((1440, 1000), (390, 844)):
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            unexpected: list[str] = []  # Populated only by fixture-route mismatches.
            verify.install_routes(page, fixture, unexpected)
            page.goto(f"{base_url}#money", wait_until="domcontentloaded")
            page.wait_for_function(
                "() => document.querySelector('#rescount')?.textContent.trim()"
                " && !document.querySelector('#list .loading')"
                " && !document.querySelector('#money-method-primary')?.hidden"
            )
            page.screenshot(path=OUTPUT / f"default-{width}.png", full_page=False)
            if width == 1440:
                page.locator("#money-more-filters > summary").click()
                page.screenshot(path=OUTPUT / "more-filters-1440.png", full_page=False)
            assert not unexpected, unexpected
            context.close()
        browser.close()
    print(f"wrote Contracts screenshots under {OUTPUT}")


if __name__ == "__main__":
    main()
