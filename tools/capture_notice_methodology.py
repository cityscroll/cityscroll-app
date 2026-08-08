#!/usr/bin/env python3
"""Capture live-rendered notice methodology chrome before and after its removal.

Uses the current checkout for the after state and a git revision for the before
state. Both pages run through the real notice route with deterministic API fixtures.
"""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "notice-methodology"
NOTICE_ID = "20260808003"
VIEWPORTS = ((390, 900), (1440, 1100))

NOTICE = {
    "request_id": NOTICE_ID,
    "agency_name": "Department of Transportation",
    "type_of_notice_description": "Award",
    "category_description": "Construction Related Services",
    "short_title": "Bridge engineering support services",
    "section_name": "Procurement",
    "start_date": "2026-08-08T00:00:00.000",
    "pin": "84124P0003001",
    "contract_amount": "13530000",
    "vendor_name": "HNTB New York Engineering and Architecture PC",
}

LIFECYCLE = {
    "ok": True,
    "pin": "84124P0003001",
    "pin_strategy": "exact",
    "timeline": [
        {
            "stage": "award",
            "status": "matched",
            "source": "city-record",
            "date": "2026-08-08",
            "amount": 13530000,
            "detail": {
                "request_id": NOTICE_ID,
                "vendor_name": "HNTB New York Engineering and Architecture PC",
                "contract_amount": 13530000,
            },
        },
        {
            "stage": "registered",
            "status": "matched",
            "source": "checkbook-contracts",
            "date": "2026-08-15",
            "amount": 13530000,
            "detail": {
                "contract_id": "CT184120268807929",
                "registration_date": "2026-08-15",
                "original_amount": 13530000,
                "current_amount": 13530000,
                "spent_to_date": 1250000,
                "start_date": "2026-08-01",
                "end_date": "2030-07-31",
                "vendor": "HNTB NEW YORK ENGINEERING & ARCHITECTURE P.C.",
            },
        },
        {
            "stage": "payment",
            "status": "matched",
            "source": "checkbook-spending",
            "date": "2026-09-01",
            "amount": 1250000,
            "detail": {
                "total_spent": 1250000,
                "total_payments": 3,
                "latest_payment_amount": 250000,
                "latest_payment_date": "2026-09-01",
            },
        },
    ],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:
        path_only, _, query = self.path.partition("?")
        if path_only.rstrip("/").startswith("/notices/"):
            self.path = "/index.html" + (f"?{query}" if query else "")
        super().do_GET()


class StaticServer:
    def __init__(self, tree: Path) -> None:
        handler = functools.partial(QuietHandler, directory=str(tree / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def revision_snapshot(revision: str, destination: Path) -> None:
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)


def fulfill_json(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def install_routes(page) -> None:
    def city_data(route: Route) -> None:
        fulfill_json(route, [NOTICE] if NOTICE_ID in route.request.url else [])

    def worker(route: Route) -> None:
        if "contract-lifecycle" in route.request.url:
            fulfill_json(route, LIFECYCLE)
        elif "priorcycle" in route.request.url:
            fulfill_json(route, {"ok": True, "id": NOTICE_ID, "strict": [], "near": []})
        else:
            fulfill_json(route, {"ok": True})

    page.route("**/resource/dg92-zbpx.json**", city_data)
    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://api.crol-list.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def capture_state(browser, tree: Path, state: str, width: int, height: int) -> dict:
    with StaticServer(tree) as base:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        errors: list[str] = list()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        page.goto(f"{base}notices/{NOTICE_ID}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#noticeview .panel", timeout=45000)
        page.wait_for_selector("#nlifecycle .lc-phase-lead", timeout=20000)
        page.wait_for_selector("#ndollars .apply", timeout=20000)
        page.wait_for_timeout(500)

        lifecycle = page.locator("#nlifecycle")
        dollars = page.locator("#ndollars")
        lifecycle_text = lifecycle.inner_text()
        dollars_text = dollars.inner_text()
        methodology_panels = lifecycle.locator("details.lc-how").count()
        if state == "before":
            assert methodology_panels > 0, lifecycle_text
            assert "Explain timeline" in lifecycle_text, lifecycle_text
            assert "matched to this notice" in dollars_text, dollars_text
        else:
            assert methodology_panels == 0, lifecycle.inner_html()
            assert "Explain timeline" not in lifecycle_text, lifecycle_text
            assert "matched to this notice" not in dollars_text, dollars_text
            assert "Checkbook NYC" in dollars_text, dollars_text

        permalink = page.locator("#noticeview .note", has_text="Permalink:").last
        if permalink.count():
            permalink.evaluate("el => { el.hidden = true; }")
        panel = page.locator("#noticeview .panel").first
        panel.scroll_into_view_if_needed()
        page.wait_for_timeout(150)
        OUT.mkdir(parents=True, exist_ok=True)
        shot = OUT / f"{state}-{width}.png"
        panel.screenshot(path=str(shot), animations="disabled")
        assert shot.stat().st_size > 8_000
        assert not errors, errors
        context.close()
        return {
            "state": state,
            "width": width,
            "methodology_panels": methodology_panels,
            "dollars_methodology_line": "matched to this notice" in dollars_text,
            "file": str(shot.relative_to(ROOT)),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", default="ca6fedcb", help="revision used for before captures")
    args = parser.parse_args()
    receipts = list()
    with tempfile.TemporaryDirectory(prefix="notice-methodology-") as tmp:
        before_tree = Path(tmp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                receipts.append(capture_state(browser, before_tree, "before", width, height))
                receipts.append(capture_state(browser, ROOT, "after", width, height))
            browser.close()
    receipt = {
        "notice_id": NOTICE_ID,
        "before_revision": args.before,
        "live_rendered_route": f"/notices/{NOTICE_ID}",
        "captures": receipts,
    }
    (OUT / "capture-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote captures to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
