#!/usr/bin/env python3
"""Capture deterministic Rules control/data separation evidence from base and current code."""

from __future__ import annotations

import argparse
from io import BytesIO
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "control-data-separation"
BASE_REV = "origin/main"
VIEWPORTS = ((390, 844), (1440, 900))

NOTICE = {
    "request_id": "20260804001",
    "start_date": "2026-07-20T00:00:00.000",
    "agency_name": "Department of Transportation",
    "section_name": "Agency Rules",
    "type_of_notice_description": "Agency Rules",
    "short_title": "Commercial loading zone rule",
    "additional_description_1": "The comment window ended on August 1, 2026.",
}

RULE = {
    "request_id": NOTICE["request_id"],
    "agency": NOTICE["agency_name"],
    "title": NOTICE["short_title"],
    "notice_date": "2026-07-20",
    "stage": "comment-closed",
    "join": {"matched": True},
    "nyc_rules": {
        "url": "https://rules.cityofnewyork.us/rule/commercial-loading-zone/",
        "comment_url": "https://rules.cityofnewyork.us/rule/commercial-loading-zone/#comments",
        "comment_by_date": "2026-08-01",
    },
    "events": [
        {
            "event_type": "proposal_published",
            "valid_at": "2026-07-20",
            "status": "occurred",
            "source_url": "https://rules.cityofnewyork.us/rule/commercial-loading-zone/",
        },
        {
            "event_type": "comment_close",
            "valid_at": "2026-08-01",
            "status": "occurred",
            "source_url": "https://rules.cityofnewyork.us/rule/commercial-loading-zone/#comments",
        },
    ],
    "rulemaking_subject_ref": "rulemaking:fixture:commercial-loading-zone",
    "rulemaking_join": {
        "matched": True,
        "confidence": "high",
        "notice_count": 1,
        "method": "fixture",
    },
    "related_notices": [],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
        def handler(*args, **kwargs):
            return QuietHandler(*args, directory=str(directory), **kwargs)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/index.html"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def base_site(destination: Path) -> Path:
    archive = subprocess.check_output(["git", "archive", BASE_REV, "site"], cwd=ROOT)
    with tarfile.open(fileobj=BytesIO(archive)) as bundle:
        bundle.extractall(destination, filter="data")
    return destination / "site"


def json_response(route: Route, payload: object, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json; charset=utf-8",
        body=json.dumps(payload),
    )


def install_routes(page: Page) -> None:
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, [NOTICE]))
    page.route("https://api.cityscroll.org/**", lambda route: json_response(route, {"ok": False}, 404))
    page.route("https://crol-worker.crol-worker.workers.dev/**", lambda route: json_response(route, {"ok": False}, 404))
    page.route(
        "https://api.cityscroll.org/rules*",
        lambda route: json_response(route, {"generated_at": "2026-08-04T12:00:00Z", "rules": [RULE]}),
    )
    page.route(
        "https://crol-worker.crol-worker.workers.dev/rules*",
        lambda route: json_response(route, {"generated_at": "2026-08-04T12:00:00Z", "rules": [RULE]}),
    )


def capture(page: Page, base: str, out: Path, state: str, width: int, height: int, lang: str) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base}#rules", wait_until="domcontentloaded", timeout=45_000)
    if lang == "es":
        page.evaluate("localStorage.setItem('crol_lang','es'); location.reload()")
        page.wait_for_load_state("domcontentloaded")
    card = page.locator("#rulesfeed .rules-fcard")
    card.wait_for(timeout=20_000)
    page.wait_for_timeout(500)
    suffix = "mobile" if width < 800 else "desktop"
    language_suffix = "-es" if lang == "es" else ""
    card.screenshot(path=str(out / f"{state}-{suffix}{language_suffix}.png"), animations="disabled")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="control-data-base-") as tmp:
        sites = (("before", base_site(Path(tmp))), ("after", ROOT / "site"))
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for state, site in sites:
                with StaticServer(site) as base:
                    for width, height in VIEWPORTS:
                        context = browser.new_context(viewport={"width": width, "height": height})
                        page = context.new_page()
                        install_routes(page)
                        capture(page, base, out, state, width, height, "en")
                        context.close()
                    if state == "after":
                        context = browser.new_context(viewport={"width": 390, "height": 844})
                        page = context.new_page()
                        install_routes(page)
                        capture(page, base, out, state, 390, 844, "es")
                        context.close()
            browser.close()

    receipt = {
        "base_revision": BASE_REV,
        "fixture": NOTICE["request_id"],
        "source": "deterministic City Record and NYC Rules fixture",
        "viewports": [width for width, _height in VIEWPORTS],
        "states": ["before", "after", "after-es"],
    }
    (out / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Captured control/data evidence under {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
