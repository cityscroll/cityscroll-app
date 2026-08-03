#!/usr/bin/env python3
"""Capture before/after Rules domain explorer screenshots (list + notice).

Serves the public ``site/`` tree and intercepts SODA + ``/rules`` with deterministic
fixtures so the list paints process-stage rails and multi-notice collapse.

  python3 tools/capture_rules_ops_ontology.py
  python3 tools/capture_rules_ops_ontology.py --out docs/screenshots/rules-ops-ontology

``before`` frames hide the domain intro / process rail and force a flat card list
(via injected CSS + a small script that re-renders feedCardHTML paths) so the PR
body can show the flat wall vs the process ontology without a second checkout.
"""

from __future__ import annotations

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "rules-ops-ontology"
VIEWPORTS = ((390, 844), (1440, 900))

# Three notices that high-confidence join as one rulemaking + one singleton.
NOTICES = [
    {
        "request_id": "20260301011",
        "start_date": "2026-03-01T00:00:00.000",
        "agency_name": "Department of Housing Preservation and Development",
        "section_name": "Agency Rules",
        "type_of_notice_description": "Proposed Rule Making",
        "short_title": "Proposed Rule — Natural Gas Detectors in Dwelling Units",
        "additional_description_1": (
            "HPD proposes rules requiring natural gas detectors. The public may "
            "submit comments through NYC Rules. Comment by May 1, 2026."
        ),
        "event_date": None,
    },
    {
        "request_id": "20260415011",
        "start_date": "2026-04-15T00:00:00.000",
        "agency_name": "Department of Housing Preservation and Development",
        "section_name": "Agency Rules",
        "type_of_notice_description": "Public Hearings",
        "short_title": "Public Hearing on Natural Gas Detectors in Dwelling Units",
        "additional_description_1": "Public hearing on the proposed natural gas detector rules.",
        "event_date": "2026-04-20T10:00:00.000",
    },
    {
        "request_id": "20260701011",
        "start_date": "2026-07-01T00:00:00.000",
        "agency_name": "Department of Housing Preservation and Development",
        "section_name": "Agency Rules",
        "type_of_notice_description": "Notice of Adoption",
        "short_title": "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
        "additional_description_1": "HPD adopts the natural gas detector rules.",
        "event_date": None,
    },
    {
        "request_id": "20260714029",
        "start_date": "2026-07-14T00:00:00.000",
        "agency_name": "Department of Transportation",
        "section_name": "Agency Rules",
        "type_of_notice_description": "Agency Rules",
        "short_title": "Commercial Meter Parking for For-Hire Vehicles",
        "additional_description_1": (
            "DOT proposes to amend commercial meter parking rules. Comments open "
            "on NYC Rules through September 15, 2026."
        ),
        "event_date": None,
    },
]

RULES_VIEW = {
    "generated_at": "2026-08-02T12:00:00.000Z",
    "rules": [
        {
            "request_id": "20260301011",
            "agency": NOTICES[0]["agency_name"],
            "title": NOTICES[0]["short_title"],
            "notice_date": "2026-03-01",
            "stage": "comment-open",
            "join": {"matched": True},
            "nyc_rules": {
                "url": "https://rules.cityofnewyork.us/?p=gas",
                "comment_url": "https://rules.cityofnewyork.us/?p=gas#comment",
                "comment_by_date": "2026-05-01",
                "hearing_date": "2026-04-20",
            },
            "events": [
                {
                    "event_type": "proposal_published",
                    "valid_at": "2026-03-01",
                    "status": "occurred",
                    "source_url": "https://rules.cityofnewyork.us/?p=gas",
                },
                {
                    "event_type": "comment_close",
                    "valid_at": "2026-05-01",
                    "status": "scheduled",
                    "source_url": "https://rules.cityofnewyork.us/?p=gas#comment",
                },
            ],
            "rulemaking_subject_ref": "rulemaking:hpd:natural-gas-detectors",
            "rulemaking_join": {
                "matched": True,
                "confidence": "high",
                "notice_count": 3,
                "method": "title_agency_window",
                "role": "proposal",
            },
            "related_notices": [
                {
                    "request_id": "20260415011",
                    "role": "hearing",
                    "title": NOTICES[1]["short_title"],
                    "notice_date": "2026-04-15",
                    "event_date": "2026-04-20",
                    "stage": "hearing",
                    "join": {
                        "matched": True,
                        "confidence": "high",
                        "method": "title_agency_window",
                    },
                },
                {
                    "request_id": "20260701011",
                    "role": "adoption",
                    "title": NOTICES[2]["short_title"],
                    "notice_date": "2026-07-01",
                    "stage": "adopted",
                    "join": {
                        "matched": True,
                        "confidence": "high",
                        "method": "title_agency_window",
                    },
                },
            ],
        },
        {
            "request_id": "20260415011",
            "agency": NOTICES[1]["agency_name"],
            "title": NOTICES[1]["short_title"],
            "notice_date": "2026-04-15",
            "stage": "hearing",
            "join": {"matched": False},
            "nyc_rules": None,
            "events": [
                {
                    "event_type": "public_hearing",
                    "valid_at": "2026-04-20",
                    "status": "scheduled",
                    "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260415011",
                }
            ],
            "rulemaking_subject_ref": "rulemaking:hpd:natural-gas-detectors",
            "rulemaking_join": {
                "matched": True,
                "confidence": "high",
                "notice_count": 3,
                "method": "title_agency_window",
                "role": "hearing",
            },
            "related_notices": [
                {
                    "request_id": "20260301011",
                    "role": "proposal",
                    "title": NOTICES[0]["short_title"],
                    "notice_date": "2026-03-01",
                    "stage": "comment-open",
                    "join": {
                        "matched": True,
                        "confidence": "high",
                        "method": "title_agency_window",
                    },
                },
                {
                    "request_id": "20260701011",
                    "role": "adoption",
                    "title": NOTICES[2]["short_title"],
                    "notice_date": "2026-07-01",
                    "stage": "adopted",
                    "join": {
                        "matched": True,
                        "confidence": "high",
                        "method": "title_agency_window",
                    },
                },
            ],
        },
        {
            "request_id": "20260701011",
            "agency": NOTICES[2]["agency_name"],
            "title": NOTICES[2]["short_title"],
            "notice_date": "2026-07-01",
            "stage": "adopted",
            "join": {"matched": True},
            "nyc_rules": {
                "url": "https://rules.cityofnewyork.us/?p=gas",
                "adoption_published_at": "2026-07-01",
            },
            "events": [
                {
                    "event_type": "adoption",
                    "valid_at": "2026-07-01",
                    "published_at": "2026-07-01",
                    "status": "occurred",
                    "source_url": "https://rules.cityofnewyork.us/?p=gas",
                }
            ],
            "rulemaking_subject_ref": "rulemaking:hpd:natural-gas-detectors",
            "rulemaking_join": {
                "matched": True,
                "confidence": "high",
                "notice_count": 3,
                "method": "title_agency_window",
                "role": "adoption",
            },
            "related_notices": [
                {
                    "request_id": "20260301011",
                    "role": "proposal",
                    "title": NOTICES[0]["short_title"],
                    "notice_date": "2026-03-01",
                    "stage": "comment-open",
                    "join": {
                        "matched": True,
                        "confidence": "high",
                        "method": "title_agency_window",
                    },
                },
                {
                    "request_id": "20260415011",
                    "role": "hearing",
                    "title": NOTICES[1]["short_title"],
                    "notice_date": "2026-04-15",
                    "event_date": "2026-04-20",
                    "stage": "hearing",
                    "join": {
                        "matched": True,
                        "confidence": "high",
                        "method": "title_agency_window",
                    },
                },
            ],
        },
        {
            "request_id": "20260714029",
            "agency": NOTICES[3]["agency_name"],
            "title": NOTICES[3]["short_title"],
            "notice_date": "2026-07-14",
            "stage": "comment-open",
            "join": {"matched": True},
            "nyc_rules": {
                "url": "https://rules.cityofnewyork.us/?p=9001",
                "comment_url": "https://rules.cityofnewyork.us/?p=9001#comment",
                "comment_by_date": "2026-09-15",
            },
            "events": [
                {
                    "event_type": "proposal_published",
                    "valid_at": "2026-07-14",
                    "status": "occurred",
                    "source_url": "https://rules.cityofnewyork.us/?p=9001",
                },
                {
                    "event_type": "comment_close",
                    "valid_at": "2026-09-15",
                    "status": "scheduled",
                    "source_url": "https://rules.cityofnewyork.us/?p=9001#comment",
                },
            ],
            "rulemaking_subject_ref": "rulemaking:notice:20260714029",
            "rulemaking_join": {
                "matched": True,
                "confidence": "high",
                "notice_count": 1,
                "method": "singleton",
            },
            "related_notices": [],
        },
    ],
}


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(directory or ROOT / "site"), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def start_server(directory: Path) -> tuple[ThreadingHTTPServer, int]:
    handler = lambda *a, **k: SiteHandler(*a, directory=directory, **k)  # noqa: E731
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


async_routes_note = None  # placemarker for static analysis


def json_response(route: Route, body: object, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json; charset=utf-8",
        body=json.dumps(body),
    )


def install_routes(page: Page) -> None:
    # Playwright matches reverse registration order: specific routes last.
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: json_response(
            route,
            [{"agency_name": a} for a in sorted({n["agency_name"] for n in NOTICES})]
            if "$group" in route.request.url
            else NOTICES,
        ),
    )
    page.route(
        "https://api.cityscroll.org/**",
        lambda route: json_response(route, {"ok": False, "reason": "fixture"}, 404),
    )
    page.route(
        "https://crol-worker.crol-worker.workers.dev/**",
        lambda route: json_response(route, {"ok": False, "reason": "fixture"}, 404),
    )
    page.route(
        "https://api.cityscroll.org/rules*",
        lambda route: json_response(route, RULES_VIEW),
    )
    page.route(
        "https://crol-worker.crol-worker.workers.dev/rules*",
        lambda route: json_response(route, RULES_VIEW),
    )


def wait_rules_list(page: Page) -> None:
    page.wait_for_selector("#rulesfeed .fcard", timeout=20000)
    # Domain intro present on after; process rail may be empty if module failed.
    page.wait_for_timeout(400)


def capture_list(page: Page, out: Path, label: str, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    base = page._base  # type: ignore[attr-defined]
    page.goto(f"{base}/#rules", wait_until="domcontentloaded")
    wait_rules_list(page)
    page.evaluate("window.scrollTo(0, 0)")
    suffix = "mobile" if width < 800 else "desktop"
    page.screenshot(path=str(out / f"{label}-rules-list-{suffix}.png"), full_page=False)
    feed = page.locator("#rulesfeed")
    if feed.count():
        feed.screenshot(path=str(out / f"{label}-rules-list-cards-{suffix}.png"))


def capture_notice(page: Page, out: Path, label: str, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    base = page._base  # type: ignore[attr-defined]
    page.goto(f"{base}/#notice/20260714029", wait_until="domcontentloaded")
    # Prefer notice-detail spine containers — not the domain-intro stepper on #tab-rules.
    page.wait_for_selector("#drules .rule-phase-stepper, #nrules .rule-phase-stepper, #drules .rule-spine-lead, #nrules .chain-h", timeout=20000)
    page.wait_for_timeout(500)
    suffix = "mobile" if width < 800 else "desktop"
    page.screenshot(path=str(out / f"{label}-rules-notice-{suffix}.png"), full_page=False)


BEFORE_CSS = """
#rules-domain-intro { display: none !important; }
#rulesprocessrail, .rules-rail-label { display: none !important; }
.rules-fcard .rules-mini-stepper,
.rules-fcard .rules-action-lead,
.rules-fcard .rules-process-line,
.rules-fcard .rules-siblings { display: none !important; }
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    server, port = start_server(ROOT / "site")
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            # AFTER (full ontology)
            context = browser.new_context()
            page = context.new_page()
            page._base = base  # type: ignore[attr-defined]
            install_routes(page)
            for w, h in VIEWPORTS:
                capture_list(page, out, "after", w, h)
                capture_notice(page, out, "after", w, h)
            # Canonical names used in PR body (desktop)
            page.set_viewport_size({"width": 1440, "height": 900})
            page.goto(f"{base}/#rules", wait_until="domcontentloaded")
            wait_rules_list(page)
            page.screenshot(path=str(out / "after-rules-list.png"), full_page=False)
            feed = page.locator("#rulesfeed")
            if feed.count():
                feed.screenshot(path=str(out / "after-rules-list-cards.png"))
            page.goto(f"{base}/#notice/20260714029", wait_until="domcontentloaded")
            page.wait_for_selector("#drules .rule-phase-stepper, #nrules .rule-phase-stepper, #drules .rule-spine-lead, #nrules .chain-h", timeout=20000)
            page.wait_for_timeout(400)
            page.screenshot(path=str(out / "after-rules-notice.png"), full_page=False)
            context.close()

            # BEFORE: abort the explorer module so the flat feed fallback paints,
            # and hide the domain intro / process rail chrome.
            context = browser.new_context()
            page = context.new_page()
            page._base = base  # type: ignore[attr-defined]
            install_routes(page)
            page.route("**/rules_explorer.mjs", lambda route: route.abort())
            page.add_init_script(
                f"""
                const style = document.createElement('style');
                style.textContent = {json.dumps(BEFORE_CSS)};
                document.documentElement.appendChild(style);
                """
            )
            page.set_viewport_size({"width": 1440, "height": 900})
            page.goto(f"{base}/#rules", wait_until="domcontentloaded")
            wait_rules_list(page)
            page.screenshot(path=str(out / "before-rules-list.png"), full_page=False)
            page.goto(f"{base}/#notice/20260714029", wait_until="domcontentloaded")
            page.wait_for_selector("#drules .rule-phase-stepper, #nrules .rule-phase-stepper, #drules .rule-spine-lead, #nrules .chain-h", timeout=20000)
            page.wait_for_timeout(400)
            page.screenshot(path=str(out / "before-rules-notice.png"), full_page=False)
            context.close()
            browser.close()
    finally:
        server.shutdown()

    print(f"Wrote screenshots under {out}")
    for pth in sorted(out.glob("*.png")):
        print(f"  {pth.name} ({pth.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
