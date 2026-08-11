#!/usr/bin/env python3
"""Headless navigation proof for agency constellation contract links.

Reproduces the two agency-page link failures users reported:

1. Diamond notice links must leave the agency page and open /notices/<id>.
2. Passport-style contract rows must be diamond links that open a real destination
   (vendor profile when no City Record notice exists).

Serves site/ through tools/local_site_server.py (same route-aware helper as CI)
and writes screenshots + a JSON receipt under site/media/review/agency-page-links/.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "media" / "review" / "agency-page-links"
AGENCY = "citywide-administrative-services"
NOTICE_ID = "20260724010"
NOTICE_LABEL = "Heat Pump Water Heaters"
VENDOR_LABEL = "QUADIENT INC"


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
    deadline = time.time() + 15
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
    # Warm one request so the process is accepting connections.
    urllib.request.urlopen(base + f"/agencies/{AGENCY}/", timeout=10).read(200)
    return proc, base


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    html = (ROOT / "site" / "agencies" / AGENCY / "index.html").read_text(encoding="utf-8")
    if f'href="/notices/{NOTICE_ID}"' not in html:
        raise SystemExit(
            f"Expected diamond notice href /notices/{NOTICE_ID} on {AGENCY}; rebuild constellation docs first."
        )
    if 'href="/vendors/QUADIENT/"' not in html:
        raise SystemExit(
            f"Expected vendor diamond href /vendors/QUADIENT/ on {AGENCY}; rebuild constellation docs first."
        )
    if re.search(rf'agency-edge-link" href="#notice/{NOTICE_ID}"', html):
        raise SystemExit("Stale SPA hash notice link still present on agency document.")

    proc, base = start_server()
    agency_path = f"/agencies/{AGENCY}/"
    receipt = {
        "agency": AGENCY,
        "base": base,
        "agency_path": agency_path,
        "checks": [],
        "frames": [],
    }

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
            page = context.new_page()

            page.goto(base + agency_path, wait_until="domcontentloaded")
            page.wait_for_selector(
                f'a.agency-edge-link[href="/notices/{NOTICE_ID}"]',
                timeout=10000,
            )
            before = OUT / "dcas-contracts-before-click.png"
            page.locator('[data-agency-constellation-category="contracts"]').scroll_into_view_if_needed()
            page.screenshot(path=str(before), full_page=False)
            receipt["frames"].append(str(before.relative_to(ROOT)))

            # Bug 1: diamond notice link navigates to the notice document route.
            with page.expect_navigation(wait_until="domcontentloaded", timeout=15000):
                page.locator(f'a.agency-edge-link[href="/notices/{NOTICE_ID}"]').click()
            notice_url = page.url
            notice_ok = f"/notices/{NOTICE_ID}" in notice_url
            notice_shot = OUT / "dcas-notice-after-diamond-click.png"
            page.screenshot(path=str(notice_shot), full_page=False)
            receipt["frames"].append(str(notice_shot.relative_to(ROOT)))
            receipt["checks"].append(
                {
                    "id": "diamond_notice_navigates",
                    "label": NOTICE_LABEL,
                    "from": agency_path,
                    "href": f"/notices/{NOTICE_ID}",
                    "landed_url": notice_url,
                    "ok": notice_ok,
                }
            )
            if not notice_ok:
                raise SystemExit(f"Diamond notice click stayed off notice route: {notice_url}")

            # Bug 2: passport contract row is a diamond link to the vendor profile.
            page.goto(base + agency_path, wait_until="domcontentloaded")
            vendor_link = page.locator('a.agency-edge-link[href="/vendors/QUADIENT/"]')
            vendor_link.wait_for(timeout=10000)
            vendor_link.scroll_into_view_if_needed()
            with page.expect_navigation(wait_until="domcontentloaded", timeout=15000):
                vendor_link.click()
            vendor_url = page.url
            vendor_ok = "/vendors/QUADIENT" in vendor_url
            vendor_shot = OUT / "dcas-vendor-after-contract-click.png"
            page.screenshot(path=str(vendor_shot), full_page=False)
            receipt["frames"].append(str(vendor_shot.relative_to(ROOT)))
            receipt["checks"].append(
                {
                    "id": "contract_row_navigates_vendor",
                    "label": VENDOR_LABEL,
                    "from": agency_path,
                    "href": "/vendors/QUADIENT/",
                    "landed_url": vendor_url,
                    "ok": vendor_ok,
                }
            )
            if not vendor_ok:
                raise SystemExit(f"Contract vendor click stayed off vendor route: {vendor_url}")

            # Working exam control path (document-shaped diamond) still leaves the agency page.
            page.goto(base + agency_path, wait_until="domcontentloaded")
            exam_link = page.locator('a.agency-edge-link[href^="/exams/"]').first
            exam_link.wait_for(timeout=10000)
            exam_href = exam_link.get_attribute("href") or ""
            with page.expect_navigation(wait_until="domcontentloaded", timeout=15000):
                exam_link.click()
            exam_url = page.url
            exam_ok = "/exams/" in exam_url
            exam_shot = OUT / "dcas-exam-control-path.png"
            page.screenshot(path=str(exam_shot), full_page=False)
            receipt["frames"].append(str(exam_shot.relative_to(ROOT)))
            receipt["checks"].append(
                {
                    "id": "exam_document_control_path",
                    "href": exam_href,
                    "landed_url": exam_url,
                    "ok": exam_ok,
                }
            )

            context.close()
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    receipt_path = OUT / "navigation-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("wrote", receipt_path.relative_to(ROOT))
    for check in receipt["checks"]:
        status = "ok" if check["ok"] else "FAIL"
        print(f"{status}: {check['id']} -> {check.get('landed_url')}")
    if not all(check["ok"] for check in receipt["checks"]):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
