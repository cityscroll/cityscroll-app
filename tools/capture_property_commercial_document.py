#!/usr/bin/env python3
"""Capture exact-notice before/after evidence for structured property cards.

The current checkout is the after state. The default before revision is HEAD,
which is useful while the fix is still uncommitted:

    python3 tools/capture_property_commercial_document.py --before HEAD
"""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from playwright.sync_api import Browser, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "property-commercial-document"
NOTICE_ID = "20170130106"
GOLDEN = json.loads(
    (ROOT / "test" / "contract" / "fixtures" / "property_location_golden.json").read_text()
)
NOTICE = next(
    item["row"] for item in GOLDEN["notices"] if item.get("row", {}).get("request_id") == NOTICE_ID
)
NOTICE = {
    **NOTICE,
    "property_location": {
        "scope": "local",
        "bbls": ["1020260015"],
        "tax_lots": [{"borough_code": "1", "block": "2026", "lot": "15", "bbl": "1020260015"}],
    },
    "disposition_stage": "hearing",
}


class QuietRouteHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if re.fullmatch(r"/notices/[^/?#]+/?", urlsplit(self.path).path):
            self.path = "/index.html"
        super().do_GET()

    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
        handler = functools.partial(QuietRouteHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

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


def json_response(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def install_routes(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())
    page.route(
        "https://data.cityofnewyork.us/resource/dg92-zbpx.json*",
        lambda route: json_response(route, [NOTICE]),
    )
    page.route(
        "**/property-locations*",
        lambda route: json_response(route, {"properties": [NOTICE], "disposition_spines": []}),
    )
    page.route(
        "**/attachment-metadata*",
        lambda route: json_response(route, {"request_id": NOTICE_ID, "attachments": []}),
    )
    page.route("https://api.cityscroll.org/**", lambda route: json_response(route, {}))
    page.route(
        "https://crol-worker.crol-worker.workers.dev/**",
        lambda route: json_response(route, {}),
    )


def capture_state(browser: Browser, site_root: Path, state: str) -> None:
    with StaticServer(site_root) as base:
        context = browser.new_context(
            viewport={"width": 1440, "height": 1000},
            device_scale_factor=1,
            color_scheme="light",
        )
        page = context.new_page()
        install_routes(page)
        page.goto(f"{base}/notices/{NOTICE_ID}", wait_until="load", timeout=30000)

        commercial = page.locator("#ncommercial")
        commercial.locator("[data-commercial-detail='1']").wait_for(state="visible", timeout=15000)
        actions = page.locator("#nactions")
        actions.locator(".next-action-rail").wait_for(state="visible", timeout=15000)
        if state == "after":
            actions.locator("[data-action-current]").wait_for(state="visible", timeout=15000)
            assert commercial.locator(".property-commercial-row").count() >= 3
            assert commercial.locator(".property-commercial-evidence cite").count() >= 2
        else:
            assert commercial.locator(".stage-name").count() >= 3

        OUTPUT.mkdir(parents=True, exist_ok=True)
        actions.screenshot(
            path=str(OUTPUT / f"{state}-notice-{NOTICE_ID}-actions.png"),
            animations="disabled",
        )
        commercial.screenshot(
            path=str(OUTPUT / f"{state}-notice-{NOTICE_ID}-commercial.png"),
            animations="disabled",
        )
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", default="HEAD", help="git revision for the before captures")
    args = parser.parse_args()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        with tempfile.TemporaryDirectory() as temp:
            before_root = Path(temp) / "before"
            before_root.mkdir()
            revision_snapshot(args.before, before_root)
            capture_state(browser, before_root / "site", "before")
        capture_state(browser, ROOT / "site", "after")
        browser.close()

    print(f"wrote exact-notice captures under {OUTPUT}")


if __name__ == "__main__":
    main()
