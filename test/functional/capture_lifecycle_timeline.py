#!/usr/bin/env python3
"""Capture annotated before/after screenshots of the contract lifecycle timeline.

Serves the site locally, intercepts the SODA and worker API calls with fixtures,
and captures the notice-detail page at 390px and 1440px in both states:
  - before: lifecycle API returns ok:false (no timeline — the pre-feature state)
  - after:  lifecycle API returns the full precomputed read model (timeline visible)

Output: docs/screenshots/lifecycle-timeline/{before,after}-{390,1440}[-annotated].png
"""

from __future__ import annotations

import argparse
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "screenshots" / "lifecycle-timeline"
VIEWPORTS = ((390, 844), (1440, 900))

NOTICE = {
    "request_id": "20250110001",
    "start_date": "2025-01-10T00:00:00.000",
    "agency_name": "Sanitation",
    "type_of_notice_description": "Award",
    "category_description": "Goods and Services",
    "short_title": "Collection Services for NYC Sanitation",
    "pin": "08250R0001001",
    "contract_amount": "5000000",
    "vendor_name": "ACME Environmental Corp",
    "additional_description_1": "Comprehensive waste collection and recycling services for designated districts.",
}

LIFECYCLE_FULL = {
    "id": "20250110001",
    "pin": "08250R0001001",
    "pin_strategy": "exact",
    "ok": True,
    "amendments": [],
    "timeline": [
        {
            "stage": "award", "status": "matched", "source": "city-record",
            "date": "2025-01-10", "source_timestamp": "2025-01-10",
            "detail": {
                "request_id": "20250110001", "agency": "Sanitation",
                "title": "Collection Services for NYC Sanitation",
                "pin": "08250R0001001", "vendor": "ACME Environmental Corp",
                "amount": 5000000,
            },
        },
        {
            "stage": "pending", "status": "matched", "source": "checkbook-contracts",
            "date": "2025-02-20", "source_timestamp": "2025-02-20",
            "detail": {
                "contract_id": "CT106820278800037", "vendor": "ACME Environmental Corp",
                "received_date": "2025-02-20", "start_date": "2025-03-01", "amount": 5000000,
            },
        },
        {
            "stage": "registered", "status": "matched", "source": "checkbook-contracts",
            "date": "2025-04-01", "source_timestamp": "2025-04-01",
            "detail": {
                "contract_id": "CT106820278800037", "vendor": "ACME Environmental Corp",
                "registration_date": "2025-04-01",
                "original_amount": 5000000, "current_amount": 5000000,
                "spent_to_date": 1500000,
                "start_date": "2025-03-01", "end_date": "2028-03-01",
                "duration": "3 years", "mwbe": "Non-M/WBE",
            },
        },
        {
            "stage": "payment", "status": "matched", "source": "checkbook-spending",
            "date": "2025-05-15", "source_timestamp": "2025-05-15",
            "detail": {
                "total_payments": 3, "total_spent": 750000,
                "latest_payment_date": "2025-05-15", "latest_payment_amount": 250000,
                "fiscal_year": "2025",
            },
        },
    ],
}

LIFECYCLE_EMPTY = {"id": "20250110001", "ok": False}


class LocalServer:
    def __init__(self, directory: str, port: int = 0):
        handler = lambda *a, **kw: SimpleHTTPRequestHandler(*a, directory=directory, **kw)
        self.server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page, lifecycle_data: dict) -> None:
    page.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    page.route("https://fonts.gstatic.com/**", lambda r: r.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda r: r.abort())

    def city_data(route: Route) -> None:
        query = {k: v[0] for k, v in parse_qs(urlparse(route.request.url).query).items()}
        select = query.get("$select", "")
        if "min(start_date)" in select:
            json_response(route, [{"a": "2025-01-01T00:00:00.000", "b": "2025-07-29T00:00:00.000"}])
        elif select.startswith("request_id,start_date"):
            rows = [NOTICE] if "request_id=" in query.get("$where", "") else [NOTICE]
            json_response(route, rows)
        else:
            json_response(route, [])

    page.route("https://data.cityofnewyork.us/**", city_data)

    def worker_api(route: Route) -> None:
        if "/contract-lifecycle" in route.request.url:
            json_response(route, lifecycle_data)
        else:
            json_response(route, {})

    page.route("https://api.cityscroll.org/**", worker_api)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker_api)


def annotate(page: Page, selector: str, label: str) -> None:
    page.evaluate(
        """({selector,label}) => {
          const t=document.querySelector(selector);
          if(!t) return;
          const rect=t.getBoundingClientRect();
          const left=Math.max(5,rect.left-6), top=Math.max(48,rect.top-6);
          const width=Math.min(innerWidth-left-5,rect.width+12);
          const mark=document.createElement("div");
          Object.assign(mark.style,{position:"fixed",left:`${left}px`,top:`${top}px`,
            width:`${width}px`,height:`${rect.height+12}px`,border:"4px solid #d60000",
            borderRadius:"8px",boxSizing:"border-box",zIndex:"99998",pointerEvents:"none"});
          const note=document.createElement("div");
          note.textContent=label;
          Object.assign(note.style,{position:"fixed",left:`${left}px`,top:`${Math.max(5,top-43)}px`,
            maxWidth:`${width}px`,background:"#d60000",color:"#fff",padding:"7px 10px",
            borderRadius:"5px",font:"800 12px/1.25 system-ui,sans-serif",zIndex:"99999",
            pointerEvents:"none"});
          document.body.append(mark,note);
        }""",
        {"selector": selector, "label": label},
    )


def capture_state(
    playwright, base_url: str, state: str, lifecycle_data: dict, output: Path
) -> None:
    for width, height in VIEWPORTS:
        browser = playwright.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": width, "height": height})
        page = ctx.new_page()
        page.set_default_timeout(30000)

        install_routes(page, lifecycle_data)
        page.goto(base_url + "#notice/20250110001", wait_until="domcontentloaded")
        page.wait_for_selector("#ncopy", timeout=15000)

        if state == "after":
            page.wait_for_function(
                "(document.querySelector('#nlifecycle')?.innerHTML||'').length > 0",
                timeout=10000,
            )
        else:
            page.wait_for_timeout(500)

        # Scroll to the lifecycle area
        page.evaluate("document.querySelector('#nlifecycle')?.scrollIntoView({block:'center'})")
        page.wait_for_timeout(300)

        raw_path = output / f"{state}-{width}.png"
        page.screenshot(path=str(raw_path), animations="disabled")
        label = "Contract lifecycle timeline" if state == "after" else "Before lifecycle timeline"
        annotate(page, "#nlifecycle", label)
        ann_path = output / f"{state}-{width}-annotated.png"
        page.screenshot(path=str(ann_path), animations="disabled")

        browser.close()
        print(f"  {raw_path.name}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture before/after contract lifecycle timeline screenshots."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT,
        help=f"Screenshot directory (default: {OUTPUT.relative_to(ROOT)})",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with LocalServer(str(ROOT)) as server:
        base_url = server.url
        with sync_playwright() as playwright:
            print("Capturing before (no lifecycle)...")
            capture_state(playwright, base_url, "before", LIFECYCLE_EMPTY, output)
            print("Capturing after (lifecycle timeline)...")
            capture_state(playwright, base_url, "after", LIFECYCLE_FULL, output)
    print(f"\nScreenshots saved to {output}/")


if __name__ == "__main__":
    main()
