#!/usr/bin/env python3
"""Capture local served Near You geometry and screenshots without committing images."""

from __future__ import annotations

from repository_revision import resolve_repository_revision

import hashlib
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000").rstrip("/")
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "near-you-regression"
REVISION = resolve_repository_revision(ROOT)


def capture(page, route: str, width: int, phase: str) -> dict:
    page.set_viewport_size({"width": width, "height": 900})
    page.goto(f"{BASE}{route}", wait_until="domcontentloaded")
    page.locator("[data-near-you-root]").wait_for()
    if phase == "before":
        page.add_style_tag(content="""
          [data-near-you-root] > .near-overview { order: 0 !important; max-width: none !important; padding-inline: 0 !important; }
          [data-near-you-root] > .near-place-guide { order: 6 !important; }
        """)
    geometry = page.evaluate("""() => {
      const rect = selector => { const box = document.querySelector(selector)?.getBoundingClientRect();
        return box && {top: box.top, bottom: box.bottom, width: box.width, height: box.height}; };
      const node = selector => document.querySelector(selector);
      return {hero: rect('.near-hero'), place: rect('.near-place-guide'), overview: rect('.near-overview'),
        switch: rect('.near-surface-switch'), results: rect('.near-results'),
        orders: Object.fromEntries(['hero', 'place-guide', 'overview', 'surface-switch', 'results'].map(name => {
          const selector = name === 'place-guide' ? '.near-place-guide' : `.near-${name}`;
          return [name, node(selector) ? getComputedStyle(node(selector)).order : null];
        })), horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1};
    }""")
    image = OUT / f"{phase}-{width}.png"
    page.screenshot(path=str(image), full_page=False)
    return {"route": route, "viewport": [width, 900], "geometry": geometry,
            "screenshot": image.name, "sha256": hashlib.sha256(image.read_bytes()).hexdigest()}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    entries = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_context(bypass_csp=True).new_page()
        phase = sys.argv[1] if len(sys.argv) > 1 else "after"
        if phase not in {"before", "after"}:
            raise SystemExit("usage: capture_near_you_regression.py [before|after]")
        entries.append(capture(page, "/near-you/", 1200, phase))
        entries.append(capture(page, "/near-you/?v=0&boro=Queens&cd=Q04", 390, phase))
        browser.close()
    manifest_path = OUT / "capture-manifest.json"
    existing = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"entries": []}
    existing["schema"] = "cityscroll.near_you_regression_capture.v1"
    existing["revision"] = REVISION
    existing["data_vintage"] = "served artifact at capture time"
    existing["entries"] = [entry for entry in existing.get("entries", []) if entry["screenshot"].split("-", 1)[0] != phase] + entries
    manifest_path.write_text(json.dumps({
        "schema": existing["schema"], "revision": existing["revision"],
        "data_vintage": existing["data_vintage"], "entries": existing["entries"],
    }, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
