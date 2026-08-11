#!/usr/bin/env python3
"""Capture Property item-type chips to prove label/count spacing.

before: label runs into count (Vehicles0 / Equipment0)
after:  flex gap keeps a clear space between label and count
"""

from __future__ import annotations

import argparse
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "property-chip-count-spacing"


def payload() -> dict:
    samples = [
        ("vehicle", "Seized vehicle auction", "20251106024"),
        ("vehicle", "Police vehicle lot", "20251106025"),
        ("equipment", "Surplus equipment sale", "20250101001"),
        ("other", "Easement interest notice", "20241112003"),
        ("other", "Air rights transfer", "20241112004"),
        ("other", "Development rights", "20241112005"),
    ]
    rows = []
    for cat, title, rid in samples:
        rows.append(
            {
                "request_id": rid,
                "title": title,
                "agency_name": "Department of Citywide Administrative Services",
                "section_name": "Property Disposition",
                "type_of_notice_description": "Sale",
                "start_date": "2025-11-06T00:00:00.000",
                "end_date": "2025-12-01T00:00:00.000",
                "event_date": "2025-12-01T00:00:00.000",
                "short_title": title,
                "street_address_1": "1 Centre St",
                "additional_description1": f"Borough of Manhattan Block 1 Lot 1 {title}",
                "commercial": {
                    "schema": "cityscroll.property_commercial.v1",
                    "request_id": rid,
                    "disposition_class": "sale",
                    "sale_eligible": True,
                    "item": {
                        "category": cat,
                        "label": cat,
                        "confidence": "high",
                        "evidence": "fixture",
                        "source": "notice_body",
                    },
                    "quantities": [],
                    "price_facts": [],
                    "primary_price": None,
                    "sale_method": {
                        "method": "online_auction",
                        "confidence": "high",
                        "evidence": "fixture",
                    },
                    "participation": {
                        "package_url": None,
                        "urls": [],
                        "emails": [],
                        "phones": [],
                        "steps": [],
                        "has_fields": False,
                    },
                    "deal_signal": {"status": "insufficient"},
                    "event_views": [
                        {
                            "kind": "auction_end",
                            "date": "2025-12-01",
                            "fmt": "2025-12-01",
                            "label_key": "property_commercial_close",
                            "chip_class": "open",
                            "source_kind": "event_date",
                            "band": None,
                        }
                    ],
                },
            }
        )
    return {
        "generated_at": "2026-08-11T00:00:00Z",
        "count": len(rows),
        "locations": rows,
        "rows": rows,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, *_args):
        return

    def do_GET(self):  # noqa: N802
        from urllib.parse import urlsplit

        if urlsplit(self.path).path.rstrip("/") in ("/browse/property", "/browse/property/"):
            self.path = "/index.html"
            return super().do_GET()
        return super().do_GET()


def capture(label: str) -> list[dict]:
    OUT.mkdir(parents=True, exist_ok=True)
    body = json.dumps(payload())
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(
                viewport={"width": 1280, "height": 900}, device_scale_factor=2
            )

            def route(request):
                url = request.request.url
                if "/property-locations" in url or "property:location" in url:
                    request.fulfill(
                        status=200, content_type="application/json", body=body
                    )
                    return
                if "dg92-zbpx" in url:
                    request.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps(payload()["rows"]),
                    )
                    return
                if url.endswith("/session"):
                    request.fulfill(
                        status=200,
                        content_type="application/json",
                        body='{"authenticated":false}',
                    )
                    return
                if "/suggestions" in url:
                    request.fulfill(
                        status=200,
                        content_type="application/json",
                        body='{"suggestions":[]}',
                    )
                    return
                if "cloudflareinsights.com" in url:
                    request.fulfill(status=204, body="")
                    return
                request.continue_()

            page.route("**/*", route)
            page.goto(f"{base}/browse/property/", wait_until="domcontentloaded")
            page.wait_for_selector("#assettabs .ui-filter-chip", timeout=30_000)
            page.wait_for_timeout(800)
            page.locator("#assettabs").screenshot(path=str(OUT / f"{label}-assettabs.png"))
            info = page.evaluate(
                """() => {
              return [...document.querySelectorAll('#assettabs .ui-filter-chip')].map(b => {
                const ct = b.querySelector('.ct');
                const cs = ct ? getComputedStyle(ct) : null;
                const bs = getComputedStyle(b);
                let gapPx = null;
                if (ct) {
                  const range = document.createRange();
                  let tn = null;
                  for (const n of b.childNodes) {
                    if (n.nodeType === 3 && n.textContent.trim()) { tn = n; break; }
                  }
                  if (tn) {
                    range.setStart(tn, Math.max(0, tn.textContent.length - 1));
                    range.setEnd(tn, tn.textContent.length);
                    const lr = range.getBoundingClientRect();
                    const cr = ct.getBoundingClientRect();
                    gapPx = cr.left - lr.right;
                  }
                }
                return {
                  textContent: b.textContent,
                  display: bs.display,
                  gap: bs.gap,
                  measuredGapPx: gapPx,
                };
              });
            }"""
            )
            (OUT / f"{label}-metrics.json").write_text(json.dumps(info, indent=2) + "\n")
            browser.close()
            return info
    finally:
        server.shutdown()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default=os.environ.get("CROL_CHIP_LABEL", "after"))
    args = parser.parse_args()
    info = capture(args.label)
    print(json.dumps(info, indent=2))
    print(f"wrote {OUT / (args.label + '-assettabs.png')}")


if __name__ == "__main__":
    main()
