#!/usr/bin/env python3
"""Capture profile and Browse de-slop evidence at mobile and desktop widths."""

from __future__ import annotations

import argparse
import functools
import json
import shutil
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "profile-browse-deslop"
VIEWPORTS = ((390, 844), (1440, 1000))
FORBIDDEN = (
    "identity not yet confirmed",
    "this summary groups the public records",
    "counts describe the records shown here",
    "bounded default is shown until the page is enhanced",
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:
        path, separator, query = self.path.partition("?")
        if path.rstrip("/").startswith(("/vendors/", "/officials/")):
            self.path = "/index.html" + (f"?{query}" if separator else "")
        super().do_GET()


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def respond_json(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def vendor_profile() -> dict:
    footprint = {
        "ok": True,
        "root": {
            "kind": "vendor",
            "ref": "vendor:stem:CAMBA",
            "stem": "CAMBA",
            "display_name": "CAMBA",
        },
        "domains": {
            name: {"status": "empty", "objects": [], "count": 0}
            for name in ("money", "land", "property", "rules", "meetings", "franchise", "people")
        },
        "vendor_footprint": {
            "qualifier_required": True,
            "award_coverage": {"linked": 0, "eligible": 273, "rate": 0},
            "section_counts": {
                "awards": {"confirmed_count": 0, "mention_count": 273, "scope_count": 273},
            },
        },
    }
    return {
        "ok": True,
        "generated": "2026-08-05T13:00:00.000Z",
        "profile": {
            "stem": "CAMBA",
            "display": "CAMBA",
            "variants": [{
                "name": "CAMBA",
                "n": 273,
                "total": 1_950_000_000,
                "first": "2007-09-14",
                "last": "2026-08-04",
            }],
            "awardCount": 273,
            "total": 1_950_000_000,
            "first": "2007-09-14",
            "last": "2026-08-04",
            "topAgencies": [],
            "recentNotices": [],
            "forecasts": [],
            "footprint": footprint,
        },
    }


def install_routes(page: Page) -> None:
    page.route("**/vendor-profile?*", lambda route: respond_json(route, vendor_profile()))
    page.route("https://data.cityofnewyork.us/**", lambda route: respond_json(route, []))


def assert_phase(page: Page, phase: str) -> None:
    text = page.locator("body").inner_text().lower()
    if phase == "before":
        assert any(phrase in text for phrase in FORBIDDEN), "baseline copy was not reproduced"
    else:
        for phrase in FORBIDDEN:
            assert phrase not in text, f"unwanted reader copy remains: {phrase}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("before", "after"))
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    generated_dirs = [ROOT / "site" / "now", ROOT / "site" / "browse"]
    cleanup_dirs = [directory for directory in generated_dirs if not directory.exists()]
    subprocess.run(
        ["node", "tools/build_primary_documents.mjs"],
        cwd=ROOT,
        check=True,
    )

    with StaticServer() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            page.goto(base + "#vendor/CAMBA", wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_selector("#vendor-footprint [data-footprint-section='awards']", timeout=30_000)
            assert_phase(page, args.phase)
            page.locator("#vendor-footprint").screenshot(
                path=str(OUT / f"{args.phase}-profile-{width}.png")
            )

            page.goto(base + "browse/", wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_selector(".browse-landing", timeout=30_000)
            assert_phase(page, args.phase)
            page.locator(".browse-landing").screenshot(
                path=str(OUT / f"{args.phase}-browse-{width}.png")
            )
            page.close()
        browser.close()

    receipt = {
        "phase": args.phase,
        "viewports": [width for width, _ in VIEWPORTS],
        "profile": "deterministic CAMBA vendor footprint rendered through the live application",
        "browse": "build-rendered Browse landing hydrated by the live application",
        "forbidden_copy": list(FORBIDDEN),
    }
    (OUT / f"{args.phase}-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    for directory in cleanup_dirs:
        shutil.rmtree(directory, ignore_errors=True)
    print(f"captured {args.phase} evidence under {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
