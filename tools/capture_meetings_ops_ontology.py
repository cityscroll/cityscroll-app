#!/usr/bin/env python3
"""Capture before/after Meetings domain explorer screenshots (list + notice).

Serves the public ``site/`` tree and intercepts SODA + ``/hearings`` with deterministic
fixtures so the list paints process-stage rails, place groups, and elevated cards.

  python3 tools/capture_meetings_ops_ontology.py
  python3 tools/capture_meetings_ops_ontology.py --out docs/screenshots/meetings-ops-ontology

``before`` frames hide the domain intro / process rail and force a flat card list
(via injected CSS + aborting meetings_explorer.mjs) so the PR body can show the
prior place-only list vs the elevated process ontology without a second checkout.
"""

from __future__ import annotations

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "meetings-ops-ontology"
VIEWPORTS = ((390, 844), (1440, 900))

# Two notices same agency+day (collapse) + one local singleton + one past held.
HEARINGS = [
    {
        "request_id": "20260812011",
        "source_section": "Public Hearings and Meetings",
        "agency": "Landmarks Preservation Commission",
        "notice_type": "Public Hearings",
        "title": "Certificate of appropriateness — 100 Main Street",
        "decides": "Whether to grant a certificate of appropriateness for 100 Main Street in SoHo",
        "event_date": "2026-08-12",
        "published_at": "2026-08-01",
        "affects": [],
        "affected_area": {
            "scope": "local",
            "boroughs": ["Manhattan"],
            "neighborhoods": ["SoHo"],
            "community_districts": [],
            "community_boards": [],
            "addresses": [],
            "street_ranges": [],
            "tax_lots": [],
            "project_names": [],
        },
        "venue": {
            "mode": "in-person",
            "building": "Municipal Building",
            "address": "1 Centre Street",
            "borough": None,
            "neighborhood": None,
        },
        "participation": {
            "links": [
                {
                    "label": "Join online",
                    "url": "https://zoom.example.com/j/landmarks",
                }
            ],
            "emails": [],
            "phones": [],
            "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260812011",
        },
        "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260812011",
        "description": (
            "Public hearing on a certificate of appropriateness. The agenda is "
            "published with this notice. Join online or testify by email."
        ),
    },
    {
        "request_id": "20260812012",
        "source_section": "Public Hearings and Meetings",
        "agency": "Landmarks Preservation Commission",
        "notice_type": "Public Hearings",
        "title": "Certificate of appropriateness — 200 Side Street",
        "decides": "Whether to grant a certificate of appropriateness for 200 Side Street in SoHo",
        "event_date": "2026-08-12",
        "published_at": "2026-08-01",
        "affects": [],
        "affected_area": {
            "scope": "local",
            "boroughs": ["Manhattan"],
            "neighborhoods": ["SoHo"],
            "community_districts": [],
            "community_boards": [],
            "addresses": [],
            "street_ranges": [],
            "tax_lots": [],
            "project_names": [],
        },
        "venue": {
            "mode": "in-person",
            "building": "Municipal Building",
            "address": "1 Centre Street",
            "borough": None,
            "neighborhood": None,
        },
        "participation": {
            "links": [],
            "emails": [],
            "phones": [],
            "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260812012",
        },
        "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260812012",
        "description": "Second item on the same LPC hearing day.",
    },
    {
        "request_id": "20260820001",
        "source_section": "Public Hearings and Meetings",
        "agency": "City Planning Commission",
        "notice_type": "Public Hearings",
        "title": "Special permit — Brooklyn industrial site",
        "decides": "Whether to certify a special permit for an industrial site in Gowanus, Brooklyn",
        "event_date": "2026-08-20",
        "published_at": "2026-08-05",
        "affects": [],
        "affected_area": {
            "scope": "local",
            "boroughs": ["Brooklyn"],
            "neighborhoods": ["Gowanus"],
            "community_districts": [],
            "community_boards": [],
            "addresses": [],
            "street_ranges": [],
            "tax_lots": [],
            "project_names": [],
        },
        "venue": {
            "mode": "hybrid",
            "building": "Spector Hall",
            "address": "22 Reade Street",
            "borough": None,
            "neighborhood": None,
        },
        "participation": {
            "links": [],
            "emails": [],
            "phones": [],
            "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260820001",
        },
        "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260820001",
        "description": "A public hearing will be held on the special permit application.",
    },
    {
        "request_id": "20260709028",
        "source_section": "Public Hearings and Meetings",
        "agency": "Franchise and Concession Review Committee",
        "notice_type": "Public Hearings",
        "title": "FCRC joint public hearing — NYPD concession",
        "decides": "Whether to approve a concession agreement for NYPD parking facilities",
        "event_date": "2026-07-16",
        "published_at": "2026-07-09",
        "affects": [],
        "affected_area": {
            "scope": "citywide",
            "boroughs": [],
            "neighborhoods": [],
            "community_districts": [],
            "community_boards": [],
            "addresses": [],
            "street_ranges": [],
            "tax_lots": [],
            "project_names": [],
        },
        "venue": {
            "mode": "in-person",
            "building": "City Hall",
            "address": "City Hall Park",
            "borough": None,
            "neighborhood": None,
        },
        "participation": {
            "links": [],
            "emails": [],
            "phones": [],
            "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260709028",
        },
        "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260709028",
        "description": "Joint public hearing of the Franchise and Concession Review Committee.",
    },
]

# SODA-shaped rows for agency dropdown + fallback path.
SODA_ROWS = [
    {
        "request_id": h["request_id"],
        "start_date": f"{h['published_at']}T00:00:00.000",
        "agency_name": h["agency"],
        "section_name": h["source_section"],
        "type_of_notice_description": h["notice_type"],
        "short_title": h["title"],
        "additional_description_1": h["description"],
        "event_date": f"{h['event_date']}T10:00:00.000",
        "street_address_1": (h.get("venue") or {}).get("address"),
        "building_name": (h.get("venue") or {}).get("building"),
    }
    for h in HEARINGS
]

HEARINGS_VIEW = {
    "generated_at": "2026-08-02T12:00:00.000Z",
    "counts": {
        "total": len(HEARINGS),
        "local": sum(1 for h in HEARINGS if h["affected_area"]["scope"] == "local"),
        "citywide": sum(1 for h in HEARINGS if h["affected_area"]["scope"] == "citywide"),
        "unlocated": 0,
    },
    "hearings": HEARINGS,
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


def json_response(route: Route, body: object, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json; charset=utf-8",
        body=json.dumps(body),
    )


def install_routes(page: Page) -> None:
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: json_response(
            route,
            [{"agency_name": a} for a in sorted({h["agency"] for h in HEARINGS})]
            if "$group" in route.request.url
            else SODA_ROWS,
        ),
    )
    page.route(
        "https://api.cityscroll.org/**",
        lambda route: (
            json_response(route, HEARINGS_VIEW)
            if "/hearings" in route.request.url
            else json_response(route, {"ok": False, "reason": "fixture"}, 404)
        ),
    )
    page.route(
        "https://crol-worker.crol-worker.workers.dev/**",
        lambda route: (
            json_response(route, HEARINGS_VIEW)
            if "/hearings" in route.request.url
            else json_response(route, {"ok": False, "reason": "fixture"}, 404)
        ),
    )


def wait_meetings_list(page: Page) -> None:
    page.wait_for_selector("#meetingsfeed .fcard, #meetingsfeed .hcard", timeout=20000)
    page.wait_for_timeout(400)


def capture_list(
    page: Page,
    out: Path,
    label: str,
    width: int,
    height: int,
    *,
    group: str | None = None,
) -> None:
    page.set_viewport_size({"width": width, "height": height})
    base = page._base  # type: ignore[attr-defined]
    # Date window: all upcoming so past + future fixtures paint.
    # Default list is flat; group=place is the opt-in place-section layout.
    qs = "when=upcoming"
    if group == "place":
        qs += "&group=place"
    page.goto(f"{base}/#meetings?{qs}", wait_until="domcontentloaded")
    wait_meetings_list(page)
    page.evaluate("window.scrollTo(0, 0)")
    suffix = "mobile" if width < 800 else "desktop"
    page.screenshot(path=str(out / f"{label}-meetings-list-{suffix}.png"), full_page=False)
    feed = page.locator("#meetingsfeed")
    if feed.count():
        feed.screenshot(path=str(out / f"{label}-meetings-list-cards-{suffix}.png"))


def capture_notice(page: Page, out: Path, label: str, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    base = page._base  # type: ignore[attr-defined]
    page.goto(f"{base}/#notice/20260812011", wait_until="domcontentloaded")
    # Notice permalink paints into #noticeview (not the Money #detail pane).
    page.wait_for_selector("#noticeview .rolename, #noticeview .panel, #nactions", timeout=20000)
    page.wait_for_timeout(500)
    suffix = "mobile" if width < 800 else "desktop"
    page.screenshot(path=str(out / f"{label}-meetings-notice-{suffix}.png"), full_page=False)


BEFORE_CSS = """
#meetings-domain-intro { display: none !important; }
#meetingsprocessrail, .meetings-rail-label { display: none !important; }
.meetings-fcard .meetings-mini-stepper,
.meetings-fcard .meetings-action-lead,
.meetings-fcard .meetings-process-line,
.meetings-fcard .meetings-siblings { display: none !important; }
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
            # AFTER (flat list default + process ontology; place groups demoted)
            context = browser.new_context()
            page = context.new_page()
            page._base = base  # type: ignore[attr-defined]
            install_routes(page)
            for w, h in VIEWPORTS:
                capture_list(page, out, "after", w, h)
                capture_notice(page, out, "after", w, h)
            page.set_viewport_size({"width": 1440, "height": 900})
            page.goto(f"{base}/#meetings?when=upcoming", wait_until="domcontentloaded")
            wait_meetings_list(page)
            page.screenshot(path=str(out / "after-meetings-list.png"), full_page=False)
            feed = page.locator("#meetingsfeed")
            if feed.count():
                feed.screenshot(path=str(out / "after-meetings-list-cards.png"))
            # Opt-in place grouping still available.
            page.goto(f"{base}/#meetings?when=upcoming&group=place", wait_until="domcontentloaded")
            wait_meetings_list(page)
            page.screenshot(path=str(out / "after-meetings-list-group-place.png"), full_page=False)
            page.goto(f"{base}/#notice/20260812011", wait_until="domcontentloaded")
            page.wait_for_selector("#noticeview .rolename, #noticeview .panel, #nactions", timeout=20000)
            page.wait_for_timeout(400)
            page.screenshot(path=str(out / "after-meetings-notice.png"), full_page=False)
            context.close()

            # BEFORE: always-on place grouping (prior default wall).
            context = browser.new_context()
            page = context.new_page()
            page._base = base  # type: ignore[attr-defined]
            install_routes(page)
            page.set_viewport_size({"width": 1440, "height": 900})
            page.goto(f"{base}/#meetings?when=upcoming&group=place", wait_until="domcontentloaded")
            wait_meetings_list(page)
            page.screenshot(path=str(out / "before-meetings-list.png"), full_page=False)
            feed = page.locator("#meetingsfeed")
            if feed.count():
                feed.screenshot(path=str(out / "before-meetings-list-cards.png"))
            page.goto(f"{base}/#notice/20260812011", wait_until="domcontentloaded")
            page.wait_for_selector("#noticeview .rolename, #noticeview .panel, #nactions", timeout=20000)
            page.wait_for_timeout(400)
            page.screenshot(path=str(out / "before-meetings-notice.png"), full_page=False)
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
