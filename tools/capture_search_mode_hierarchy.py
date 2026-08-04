#!/usr/bin/env python3
"""Capture deterministic before/after evidence for exact-search and Ask hierarchy."""

from __future__ import annotations

import argparse
from io import BytesIO
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "search-mode-hierarchy"
BASE_REV = "origin/main"
VIEWPORTS = ((1440, 1000), (390, 844))


def load_performance_helpers():
    path = ROOT / "test" / "performance" / "verify.py"
    spec = importlib.util.spec_from_file_location("performance_verify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def base_site(destination: Path) -> Path:
    archive = subprocess.check_output(["git", "archive", BASE_REV, "site"], cwd=ROOT)
    with tarfile.open(fileobj=BytesIO(archive)) as bundle:
        bundle.extractall(destination, filter="data")
    return destination / "site"


def capture_region(page: Page, output: Path) -> None:
    if page.viewport_size["width"] < 800:
        page.evaluate("document.querySelector('header.masthead').style.display='none'")
        page.screenshot(path=output, animations="disabled", full_page=False)
        return
    bounds = page.locator("#tab-money .wrap").bounding_box()
    if not bounds:
        raise RuntimeError("Contracts lens did not render")
    page.screenshot(
        path=output,
        animations="disabled",
        clip={
            "x": bounds["x"],
            "y": bounds["y"],
            "width": bounds["width"],
            "height": min(bounds["height"], 620),
        },
    )


def load_contracts(page: Page, base_url: str) -> None:
    page.goto(f"{base_url}#money", wait_until="domcontentloaded")
    page.wait_for_function(
        "() => document.querySelector('#rescount')?.textContent.trim()"
        " && !document.querySelector('#list .loading')"
    )


def exercise_takeover(page: Page, is_after: bool) -> None:
    if is_after:
        page.locator('[data-ask-lens="money"] > summary').click()
    page.locator("#nlq").fill("construction contracts over $500k")
    page.locator("#nlgo").click()
    page.wait_for_function("() => document.querySelector('#kw')?.value.includes('construction')")
    page.locator("#kw").fill("housing")
    page.wait_for_timeout(650)
    if is_after:
        assert page.locator("#nlq").input_value() == ""
        assert not page.locator('[data-ask-lens="money"]').get_attribute("open")
        assert page.evaluate("() => Object.keys(moneyNlResolved).length") == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    verify = load_performance_helpers()
    fixture = json.loads(
        (ROOT / "test" / "performance" / "fixtures" / "contracts.keyword-housing.json").read_text()
    )

    with tempfile.TemporaryDirectory(prefix="search-hierarchy-base-") as tmp:
        sites = (("before", base_site(Path(tmp))), ("after", ROOT / "site"))
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for state, site in sites:
                with verify.StaticServer(site) as base_url:
                    for width, height in VIEWPORTS:
                        context = browser.new_context(viewport={"width": width, "height": height})
                        page = context.new_page()
                        unexpected: list[str] = []
                        verify.install_routes(page, fixture, unexpected)
                        load_contracts(page, base_url)
                        suffix = "desktop" if width > 800 else "mobile"
                        capture_region(page, out / f"{state}-{suffix}.png")
                        if width > 800:
                            exercise_takeover(page, state == "after")
                            capture_region(page, out / f"{state}-exact-takeover.png")
                        assert not unexpected, unexpected
                        context.close()
            browser.close()

    receipt = {
        "base_revision": BASE_REV,
        "fixture": "contracts.keyword-housing.json",
        "viewports": [width for width, _height in VIEWPORTS],
        "scenarios": ["default hierarchy", "Ask followed by exact-search takeover"],
    }
    (out / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Captured search hierarchy evidence under {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
