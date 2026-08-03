#!/usr/bin/env python3
"""Capture before/after Rules timeline screenshots with adoption-lag ghost estimate.

Serves site/ locally, intercepts /rules with a closed-comment fixture, and
writes a before (no model) / after (ghost Estimate segment) pair for the PR.

    python3 tools/capture_rules_adoption_lag.py
    python3 tools/capture_rules_adoption_lag.py --out docs/screenshots/rules-adoption-lag
"""

from __future__ import annotations

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "rules-adoption-lag"
NOTICE_ID = "20260605058"
VIEWPORTS = ((390, 844), (1440, 900))

NOTICE = {
    "request_id": NOTICE_ID,
    "start_date": "2026-06-09T00:00:00.000",
    "agency_name": "Finance",
    "section_name": "Agency Rules",
    "type_of_notice_description": "Public Hearings",
    "short_title": (
        "Proposed Rule for Surcharge on Property That Does Not Serve as a Primary Residence"
    ),
    "event_date": "2026-07-09T11:00:00.000",
    "additional_description_1": "Public hearing and opportunity to comment.",
}

RULE_RECORD = {
    "request_id": NOTICE_ID,
    "agency": NOTICE["agency_name"],
    "title": NOTICE["short_title"],
    "notice_date": NOTICE["start_date"],
    "stage": "comment-closed",
    "nyc_rules": {
        "url": "https://rules.cityofnewyork.us/rule/primary-residence-surcharge/",
        "comment_url": "https://rules.cityofnewyork.us/rule/primary-residence-surcharge/#comments",
        "comment_by_date": "2026-07-09",
        "hearing_date": "2026-07-09",
        "adoption_published_at": None,
        "effective_date": None,
    },
    "events": [
        {
            "event_type": "proposal_published",
            "valid_at": "2026-06-09",
            "valid_at_precision": "day",
            "valid_timezone": "America/New_York",
            "status": "occurred",
        },
        {
            "event_type": "public_hearing",
            "valid_at": "2026-07-09",
            "valid_at_precision": "day",
            "valid_timezone": "America/New_York",
            "status": "occurred",
        },
        {
            "event_type": "comment_close",
            "valid_at": "2026-07-09",
            "valid_at_precision": "day",
            "valid_timezone": "America/New_York",
            "status": "occurred",
            "alert": {
                "eligible": True,
                "trigger_field": "valid_at",
                "lead_days": [14, 3, 1, 0],
            },
        },
    ],
    "join": {"matched": True, "confidence": "high", "basis": "fixture"},
    "rulemaking_join": {
        "matched": True,
        "confidence": "high",
        "notice_count": 1,
    },
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
        return f"http://127.0.0.1:{self.server.server_port}/index.html"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route: Route, body: object, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json; charset=utf-8",
        body=json.dumps(body),
    )


def install_routes(page: Page, with_model: bool) -> None:
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: json_response(route, [NOTICE]),
    )
    page.route(
        "https://api.cityscroll.org/**",
        lambda route: json_response(route, {"ok": False, "reason": "fixture"}, 404),
    )
    page.route(
        "https://api.cityscroll.org/rules*",
        lambda route: json_response(
            route,
            {
                "schema_version": 2,
                "generated_at": "2026-08-01T12:00:00Z",
                "rules": [RULE_RECORD],
            },
        ),
    )
    if not with_model:
        page.route(
            "**/data/rules_adoption_lag_model.json",
            lambda route: route.fulfill(status=404, body="missing"),
        )


def capture_state(playwright, base: str, out: Path, state: str, with_model: bool) -> None:
    for width, height in VIEWPORTS:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        install_routes(page, with_model=with_model)

        page.goto(
            f"{base}#notice/{NOTICE_ID}",
            wait_until="domcontentloaded",
            timeout=45_000,
        )
        spine = page.locator("#nrules")
        spine.locator(".chain-h").wait_for(timeout=20_000)
        page.wait_for_timeout(600)

        if with_model:
            # Ghost estimate chip after closed comment period.
            est = spine.locator("[data-rule-adoption-estimate]")
            est.wait_for(timeout=10_000)
            assert est.count() >= 1
            assert spine.get_by_text("Estimate", exact=True).count() >= 1
            assert spine.get_by_text("Predicted based on", exact=False).count() >= 1
        else:
            assert spine.locator("[data-rule-adoption-estimate]").count() == 0

        page.evaluate("document.querySelector('#nrules')?.scrollIntoView({block:'center'})")
        page.wait_for_timeout(200)

        raw = out / f"{state}-{width}.png"
        page.screenshot(path=str(raw), animations="disabled")
        # Cropped spine-only shot for the PR body.
        spine.screenshot(path=str(out / f"{state}-spine-{width}.png"))

        context.close()
        browser.close()
        print(f"  {raw.relative_to(ROOT) if raw.is_relative_to(ROOT) else raw}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    with StaticServer() as base, sync_playwright() as playwright:
        print("Capturing before (closed comment, no adoption-lag model)...")
        capture_state(playwright, base, out, "before", with_model=False)
        print("Capturing after (ghost Estimate segment)...")
        capture_state(playwright, base, out, "after", with_model=True)
    print(f"Done → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
