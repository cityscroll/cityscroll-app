#!/usr/bin/env python3
"""Capture deterministic CAMBA vendor-footprint reader-copy evidence."""

from __future__ import annotations

import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "evidence" / "vendor-footprint-reader-polish"

COUNTS = {
    "awards": 273,
    "land": 0,
    "property": 0,
    "rules": 0,
    "meetings": 0,
    "payments": 0,
    "franchise": 0,
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


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


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def footprint_response() -> dict:
    section_counts = {
        section: {
            "confirmed_count": 0,
            "mention_count": count,
            "scope_count": count,
        }
        for section, count in COUNTS.items()
    }
    domains = {
        name: {"status": "empty", "objects": [], "count": 0}
        for name in ("money", "land", "property", "rules", "meetings", "franchise", "people")
    }
    return {
        "ok": True,
        "root": {
            "kind": "vendor",
            "ref": "vendor:stem:CAMBA",
            "stem": "CAMBA",
            "display_name": "CAMBA",
        },
        "domains": domains,
        "vendor_footprint": {
            "qualifier_required": True,
            "award_coverage": {"linked": 0, "eligible": 273, "rate": 0},
            "section_counts": section_counts,
            "provenance": {"denominator_materialized_at": "2026-08-05"},
        },
    }


def profile_payload() -> dict:
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
            "footprint": footprint_response(),
        },
    }


def install_fixtures(page: Page) -> None:
    page.route(
        "**/vendor-profile?*",
        lambda route: json_response(route, profile_payload()),
    )
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: json_response(route, []),
    )


def old_footprint_html() -> str:
    sections = []
    for label in ("Awards", "Payments", "Land use", "Property", "Rules", "Meetings", "Franchises and concessions"):
        coverage = (
            "showing 0 of 273 known awards linked so far (0%)"
            if label == "Awards"
            else "coverage not measured for this section; showing strong links only"
        )
        link = "" if label == "Franchises and concessions" else (
            f'<a class="vendor-footprint-scope">View this vendor as a {label.lower()} scope →</a>'
        )
        sections.append(
            f"""<section class="ei-domain vendor-footprint-section">
              <h3 class="ei-domain-h">{label} <span class="ct">0</span></h3>
              <p class="vendor-footprint-coverage">{coverage}</p>
              <p class="ei-empty">No strongly linked records in this build.</p>
              {link}
            </section>"""
        )
    return f"""<div class="eicard vendor-footprint">
      <div class="chain-h" style="margin:0 0 8px">Vendor city footprint</div>
      <p class="ei-lead">Published records linked to CAMBA, grouped by what they show.</p>
      <div class="ei-domains">{''.join(sections)}</div>
    </div>"""


def capture(page: Page, base: str) -> None:
    page.goto(base + "#vendor/CAMBA", wait_until="domcontentloaded")
    page.wait_for_selector("#vendor-footprint [data-footprint-section='awards']")
    host = page.locator("#vendor-footprint")
    host.screenshot(path=str(OUTPUT / "after.png"))
    page.locator("#vendor-footprint").evaluate("(node, html) => { node.innerHTML = html; }", old_footprint_html())
    host.screenshot(path=str(OUTPUT / "before.png"))


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1080, "height": 900})
        install_fixtures(page)
        capture(page, base)
        browser.close()
    print(f"wrote {OUTPUT.relative_to(ROOT)}/before.png and after.png")


if __name__ == "__main__":
    main()
