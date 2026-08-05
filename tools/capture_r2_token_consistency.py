#!/usr/bin/env python3
"""Capture desktop/mobile evidence for the R2 document token contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "r2-token-consistency"
SURFACES = {
    "near-you": ("near-you/borough/queens/", "[data-near-you-root][data-enhanced='true']"),
    "following": ("following/", "[data-following-preview-form]"),
}
VIEWPORTS = ((390, 844), (1440, 900))


def start_server():
    ready = tempfile.NamedTemporaryFile(prefix="crol-token-capture-", delete=False)
    ready_path = Path(ready.name)
    ready.close()
    process = subprocess.Popen(
        [
            "python3",
            str(ROOT / "tools" / "local_site_server.py"),
            "--directory",
            str(ROOT / "site"),
            "--port",
            "0",
            "--ready-file",
            str(ready_path),
        ],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    for _ in range(80):
        if ready_path.stat().st_size:
            return process, ready_path, ready_path.read_text().strip()
        if process.poll() is not None:
            raise RuntimeError(process.stderr.read().strip() or "local site server exited")
        time.sleep(0.05)
    process.terminate()
    raise RuntimeError("local site server did not become ready")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", choices=("before", "after"), required=True)
    args = parser.parse_args()

    OUTPUT.mkdir(parents=True, exist_ok=True)
    server, ready_path, base = start_server()
    captures = list()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for surface, (route, ready_selector) in SURFACES.items():
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    page.goto(f"{base}/{route}", wait_until="domcontentloaded")
                    page.locator(ready_selector).wait_for(state="visible", timeout=20_000)
                    page.evaluate("() => document.fonts.ready")
                    path = OUTPUT / f"{args.state}-{surface}-{width}.png"
                    page.screenshot(path=str(path), full_page=False)
                    captures.append(path.name)
                    context.close()
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)
        ready_path.unlink(missing_ok=True)

    manifest_path = OUTPUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        "feature": "r2-token-consistency",
        "surfaces": ["/near-you/borough/queens/", "/following/"],
        "viewports": [390, 1440],
    }
    manifest[args.state] = captures
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote", ", ".join(captures))


if __name__ == "__main__":
    main()
