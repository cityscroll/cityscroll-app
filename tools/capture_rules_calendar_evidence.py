#!/usr/bin/env python3
"""Capture before/after evidence for the rulemaking participation month (CBICS-03).

The browser runs the real public ``site/index.html`` and intercepts only its data
requests with deterministic, live-shaped City Record and ``/rules`` fixtures —
the same mechanism ``capture_rule_event_spine.py`` uses for RD-S4.

Fixture states:
  - dense:   proposal + hearing + comment-close inside a 42-day window -> the
             shared compact month renders between related notices and history.
  - sparse:  a single known date -> the existing lifecycle renders with no
             calendar placeholder (A5).
  - partial: the same dense cluster renders the month, plus an observed
             adoption event whose date is not yet known -> partial historical
             coverage stays visible next to the rendered month (A4).

    python3 tools/capture_rules_calendar_evidence.py
    python3 tools/capture_rules_calendar_evidence.py --out artifacts/cbics-03
"""

from __future__ import annotations

import argparse
import functools
import json
import subprocess
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Page, Route, sync_playwright

from local_site_server import QuietHandler

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "rules-participation-month"
NOTICE_ID = "CR-RULE-CALENDAR-001"
VIEWPORTS = ((390, 844), (1440, 900))
TIMEZONE = "America/New_York"

NOTICE = {
    "request_id": NOTICE_ID,
    "start_date": "2026-08-20T00:00:00.000",
    "agency_name": "Department of Transportation",
    "section_name": "Agency Rules",
    "type_of_notice_description": "Agency Rules",
    "short_title": "Commercial Meter Parking for For-Hire Vehicles",
    "additional_description_1": (
        "The Department of Transportation proposes to amend rules governing "
        "commercial parking meters. The public may submit comments through NYC Rules."
    ),
}

NYC_RULES = {
    "url": "https://rules.cityofnewyork.us/rule/meter-parking/",
    "comment_url": "https://rules.cityofnewyork.us/rule/meter-parking/#comments",
    "comment_by_date": "2026-09-25",
    "hearing_date": "2026-09-18",
}

DENSE_EVENTS = [
    {"event_type": "proposal_published", "valid_at": "2026-08-20", "status": "occurred"},
    {"event_type": "public_hearing", "valid_at": "2026-09-18", "status": "scheduled"},
    {"event_type": "comment_close", "valid_at": "2026-09-25", "status": "scheduled"},
]

SPARSE_EVENTS = [
    {"event_type": "comment_close", "valid_at": "2026-09-25", "status": "scheduled"},
]

PARTIAL_EVENTS = DENSE_EVENTS + [
    {"event_type": "adoption", "valid_at": None, "status": "occurred"},
]

FIXTURES = {
    "dense": DENSE_EVENTS,
    "sparse": SPARSE_EVENTS,
    "partial": PARTIAL_EVENTS,
}


def rule_record(events: list[dict]) -> dict:
    return {
        "request_id": NOTICE_ID,
        "agency": NOTICE["agency_name"],
        "title": NOTICE["short_title"],
        "notice_date": NOTICE["start_date"],
        "stage": "comment-open",
        "nyc_rules": NYC_RULES,
        "events": events,
        "join": {"matched": True, "confidence": "high", "basis": "fixture"},
    }


class StaticServer:
    # `_site` is the built public artifact shape (site/ plus root-level
    # capability modules such as capabilities/*.mjs) — the same tree
    # tools/local_site_server.py serves for the CI-equivalent browser gates.
    # Raw site/ alone 404s on those capability imports mid-boot.
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "_site"))
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


def install_routes(page: Page, record: dict) -> None:
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: json_response(route, [NOTICE]),
    )
    # Playwright evaluates matching routes in reverse registration order, so the
    # broad fail-soft API fixture is registered before the specific Rules payload.
    page.route(
        "https://api.cityscroll.org/**",
        lambda route: json_response(route, {"ok": False, "reason": "fixture"}, 404),
    )
    page.route(
        "https://api.cityscroll.org/rules*",
        lambda route: json_response(
            route,
            {"schema_version": 2, "generated_at": "2026-08-01T12:00:00Z", "rules": [record]},
        ),
    )


def capture_fixture(playwright, base: str, out: Path, fixture: str, revision: str) -> list[dict]:
    record = rule_record(FIXTURES[fixture])
    route = f"#notice/{NOTICE_ID}"
    captures: list[dict] = []
    for width, height in VIEWPORTS:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        install_routes(page, record)

        page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=45_000)
        spine = page.locator("#nrules")
        spine.locator(".chain-h").first.wait_for(timeout=20_000)

        month = spine.locator(".compact-month")
        if fixture == "sparse":
            assert month.count() == 0, "sparse fixture must not render a calendar placeholder"
            assert spine.get_by_text("Rule lifecycle", exact=True).count() == 1
            rendered = False
            assertion = "fixture=sparse: no .compact-month mounted; existing lifecycle heading renders"
        else:
            month.first.wait_for(timeout=20_000)
            assert month.count() == 1, "dense/partial fixtures must render exactly one calendar"
            assert month.get_by_text("Public hearing", exact=False).count() >= 1
            assert month.get_by_text("Comment period closes", exact=False).count() >= 1
            assert spine.get_by_text("Awaiting agency action", exact=False).count() == 0, (
                "derived lifecycle state must never appear inside the calendar"
            )
            rendered = True
            if fixture == "partial":
                assert spine.get_by_text("Date unknown", exact=False).count() >= 1, (
                    "partial fixture must keep the unresolved adoption date visible"
                )
                assertion = (
                    "fixture=partial: .compact-month renders alongside an unresolved "
                    "'Date unknown' adoption row in the full history below it"
                )
            else:
                assertion = "fixture=dense: .compact-month renders proposal/hearing/comment-close"

        overflow = page.evaluate(
            """() => ({
              page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              spine: document.querySelector('#nrules').scrollWidth > document.querySelector('#nrules').clientWidth
            })"""
        )
        assert overflow == {"page": False, "spine": False}, overflow

        focus_selector = "#nrules .compact-month" if fixture != "sparse" else "#nrules .chain-h"
        page.evaluate(
            "(sel) => document.querySelector(sel)?.scrollIntoView({block:'start'})", focus_selector
        )
        page.wait_for_timeout(200)

        screenshot = out / f"{fixture}-{width}x{height}.png"
        page.screenshot(path=str(screenshot), animations="disabled")

        captures.append({
            "fixture": fixture,
            "vintage": "synthetic-fixture",
            "route": route,
            "viewport": {"width": width, "height": height},
            "timezone": TIMEZONE,
            "revision": revision,
            "screenshot": str(screenshot.relative_to(ROOT)),
            "rendered": rendered,
            "assertion": assertion,
        })
        print(f"  {screenshot.relative_to(ROOT)}")

        context.close()
        browser.close()
    return captures


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def capture(out: Path | None = None) -> Path:
    target = out or DEFAULT_OUT
    target.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    receipt = {
        "schema": "cityscroll.rules_calendar_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "revision": revision,
        "timezone": TIMEZONE,
        "captures": [],
    }
    with StaticServer() as base, sync_playwright() as playwright:
        for fixture in ("dense", "sparse", "partial"):
            print(f"Capturing {fixture}...")
            receipt["captures"].extend(capture_fixture(playwright, base, target, fixture, revision))
    (target / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"  {(target / 'capture-receipt.json').relative_to(ROOT)}")
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Screenshot directory (default: docs/screenshots/rules-participation-month)",
    )
    args = parser.parse_args()
    capture(args.out.resolve() if args.out else None)


if __name__ == "__main__":
    main()
