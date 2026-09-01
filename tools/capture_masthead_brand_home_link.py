#!/usr/bin/env python3
"""Capture deterministic evidence for the masthead brand home link.

Serves the tracked static site, then for Home and /search/?q=rats at 1440px and
390px: captures the masthead, proves clicking the SVG mark and the wordmark both
open "/", and proves the brand link is a single keyboard tab stop that activates
with Enter. Representative document-mast surfaces (Following, Near You, one
tracked civic document) get the same click/keyboard assertions without captures.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "masthead-brand-home-link"
VIEWPORTS = ((1440, 1000), (390, 844))
BRAND = "a.brand-lockup--masthead"
DOC_BRAND = "a.document-brand"


def load_performance_helpers():
    path = ROOT / "test" / "performance" / "verify.py"
    spec = importlib.util.spec_from_file_location("performance_verify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def capture_masthead(page: Page, output: Path, selector: str) -> None:
    bounds = page.locator(selector).bounding_box()
    if not bounds:
        raise RuntimeError(f"masthead brand did not render: {selector}")
    width = page.viewport_size["width"]
    page.screenshot(
        path=output,
        animations="disabled",
        clip={
            "x": 0,
            "y": 0,
            "width": width,
            "height": min(bounds["y"] + bounds["height"] + 160, page.viewport_size["height"]),
        },
    )


def focus_brand(page: Page, selector: str) -> None:
    page.keyboard.press("Home")
    for _ in range(12):
        page.keyboard.press("Tab")
        focused = page.evaluate(
            "(sel) => document.activeElement?.matches(sel) || false", selector
        )
        if focused:
            return
    raise RuntimeError(f"brand link never received keyboard focus: {selector}")


def exercise_brand(page: Page, base_url: str, path: str, selector: str, label: str) -> dict:
    results = {"surface": label, "path": path}
    page.goto(f"{base_url}{path.lstrip('/')}", wait_until="domcontentloaded")
    page.wait_for_selector(selector)
    brand = page.locator(selector)
    assert brand.get_attribute("href") == "/", f"{label}: href must be /"
    assert brand.get_attribute("aria-label") == "CityScroll home", f"{label}: accessible name"
    assert brand.locator("svg.brand-mark[aria-hidden=true]").count() == 1, f"{label}: hidden mark"
    assert brand.locator("a, button, input, select, textarea").count() == 0, f"{label}: nesting"
    assert page.locator(f"{selector} .cr-tagline").count() == 0, f"{label}: tagline outside link"
    results["click_mark"] = "svg.brand-mark"
    brand.locator("svg.brand-mark").click()
    page.wait_for_url(f"{base_url}")
    assert page.url == base_url, f"{label}: mark click must open /, got {page.url}"

    page.goto(f"{base_url}{path.lstrip('/')}", wait_until="domcontentloaded")
    wordmark = page.locator(selector)
    if wordmark.locator("h1.cr-title").count():
        wordmark.locator("h1.cr-title").click()
    else:
        wordmark.locator("span").last.click()
    page.wait_for_url(f"{base_url}")
    assert page.url == base_url, f"{label}: wordmark click must open /, got {page.url}"
    results["click_wordmark"] = "opens /"

    page.goto(f"{base_url}{path.lstrip('/')}", wait_until="domcontentloaded")
    focus_brand(page, selector)
    page.keyboard.press("Enter")
    page.wait_for_url(f"{base_url}")
    assert page.url == base_url, f"{label}: Enter must open /, got {page.url}"
    results["keyboard"] = "single tab stop, Enter opens /"
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    verify = load_performance_helpers()
    results: list[dict] = []
    captures: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        with verify.StaticServer(ROOT / "site") as base_url:
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                suffix = "desktop" if width > 800 else "mobile"
                for path, label in (("", "home"), ("search/?q=rats", "search-rats")):
                    page.goto(f"{base_url}{path}", wait_until="domcontentloaded")
                    page.wait_for_selector(BRAND)
                    name = f"{label}-{suffix}.png"
                    capture_masthead(page, out / name, BRAND)
                    captures.append(name)
                    # Keyboard focus ring is part of the evidence set.
                    focus_brand(page, BRAND)
                    focus_name = f"{label}-{suffix}-focus.png"
                    capture_masthead(page, out / focus_name, BRAND)
                    captures.append(focus_name)
                context.close()

            # Behavior assertions (A1-A4) on the captured routes at both widths.
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                for path, label in (("", "home"), ("search/?q=rats", "search-rats")):
                    results.append(
                        exercise_brand(page, base_url, path, BRAND, f"{label}@{width}")
                    )
                context.close()

            # Representative document-mast surfaces (A2): one desktop pass each.
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            for path, label in (
                ("following/", "following"),
                ("near-you/", "near-you"),
                ("exams/7311/", "civic-document-exam"),
            ):
                results.append(exercise_brand(page, base_url, path, DOC_BRAND, label))
            context.close()
        browser.close()

    receipt = {
        "viewports": [width for width, _height in VIEWPORTS],
        "captured_routes": ["/", "/search/?q=rats"],
        "asserted_routes": ["/", "/search/?q=rats", "/following/", "/near-you/", "/exams/7311/"],
        "captures": captures,
        "results": results,
    }
    (out / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Captured masthead brand home-link evidence under {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
