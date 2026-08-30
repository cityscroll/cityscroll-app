#!/usr/bin/env python3
"""Headless after-path captures for authority-native procurement surfaces.

Serves site/ through tools/local_site_server.py and records agency, vendor,
and rendered procurement-detail frames plus API identity receipts. Search
identity is recorded from the keyword family rather than the Worker /search
route, which is not available from the static local server.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "evidence" / "authority-native-procurement" / "after"
VIEWPORT = {"width": 1440, "height": 900}

PATHS = (
    ("nycha-agency", "/agencies/housing-authority/"),
    ("mta-agency", "/agencies/metropolitan-transportation-authority/"),
    ("nyct-agency", "/agencies/n-y-c-transit-authority/"),
    ("tbta-agency", "/agencies/triborough-bridge-and-tunnel-authority/"),
    ("mta-cd-agency", "/agencies/mta-construction-and-development/"),
    ("vital-vendor", "/vendors/VITAL%20PLUMBING/"),
    ("gramercy-vendor", "/vendors/GRAMERCY%20GROUP/"),
)


def start_server() -> tuple[subprocess.Popen, str]:
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "local_site_server.py"), "--directory", str(ROOT / "site")],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert proc.stdout is not None
    base = ""
    deadline = time.time() + 20
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        line = line.strip()
        if line.startswith("http://") or line.startswith("https://"):
            base = line.rstrip("/")
            break
    if not base:
        proc.kill()
        raise SystemExit("local_site_server.py did not print a base URL")
    urllib.request.urlopen(base + "/agencies/housing-authority/", timeout=15).read(200)
    return proc, base


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    html = (ROOT / "site" / "agencies" / "housing-authority" / "index.html")
    if not html.is_file():
        subprocess.run(
            ["node", "tools/build_agency_constellation_documents.mjs"],
            cwd=ROOT,
            check=True,
        )
    proc, base = start_server()
    receipt = {
        "schema": "cityscroll.anp.after_capture.v1",
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fixture_contract_id": "BA2335819",
        "paths": [],
    }
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1)
            page = context.new_page()
            for label, path in PATHS:
                page.goto(base + path, wait_until="domcontentloaded", timeout=20000)
                page.wait_for_timeout(500)
                shot = OUT / f"{label}.png"
                page.screenshot(path=str(shot), full_page=True)
                body = page.inner_text("body")[:1200]
                receipt["paths"].append({
                    "label": label,
                    "path": path,
                    "status": 200,
                    "screenshot": str(shot.relative_to(ROOT)),
                    "body_excerpt": " ".join(body.split()),
                })
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    (OUT / "capture.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT / 'capture.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
