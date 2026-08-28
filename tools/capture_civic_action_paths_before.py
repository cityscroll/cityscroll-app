#!/usr/bin/env python3
"""Capture the current civic-action-paths surfaces at desktop and mobile widths.

The browser uses the real checked-in site tree, a loopback static server, and
source-shaped fixtures derived from the checked-in meeting/rules artifacts.
No interactive browser session or request-time publisher read is used.
"""

from __future__ import annotations

import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_SITE = ROOT / ".capture-site"
OUT = ROOT / "docs" / "evidence" / "civic-action-paths" / "before"
VIEWPORTS = ((1440, 1000, "desktop"), (390, 844, "mobile"))

MEETING_IDS = {
    "strict_matter_join": "20260707022",
    "multi_matter_join": "20260707021",
    "no_matter_join": "20260728026",
}

MEETING_ROWS = {
    "20260707022": {
        "request_id": "20260707022",
        "start_date": "2026-07-16T00:00:00.000",
        "event_date": "2026-07-22T11:00:00.000",
        "agency_name": "City Council",
        "type_of_notice_description": "Public Hearings",
        "section_name": "Public Hearings and Meetings",
        "short_title": "7-22-26 Subcommittee on Landmarks, Public Sitings, Resiliency, and Dispositions meeting",
        "additional_description_1": "Meeting of the City Council Subcommittee on Landmarks, Public Sitings, Resiliency, and Dispositions.",
    },
    "20260707021": {
        "request_id": "20260707021",
        "start_date": "2026-07-15T00:00:00.000",
        "event_date": "2026-07-21T11:00:00.000",
        "agency_name": "City Council",
        "type_of_notice_description": "Public Hearings",
        "section_name": "Public Hearings and Meetings",
        "short_title": "7-21-26 Subcommittee on Zoning and Franchises meeting",
        "additional_description_1": "Meeting of the City Council Subcommittee on Zoning and Franchises.",
    },
    "20260728026": {
        "request_id": "20260728026",
        "start_date": "2026-08-04T00:00:00.000",
        "event_date": "2026-09-09T11:00:00.000",
        "agency_name": "Buildings",
        "type_of_notice_description": "Public Hearings",
        "section_name": "Agency Rules",
        "short_title": "Proposed Rule - Rule relating to Incomplete Inspections",
        "additional_description_1": "A public hearing and opportunity to comment.",
    },
}

MEETING_OUTCOMES = {
    "20260707022": {
        "join": {"matched": True, "method": "exact_date_body_tokens", "reason": None},
        "council_event": {
            "event_id": "22509",
            "title": "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions",
            "body_name": "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions",
            "event_url": "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22509&GID=61&G=2FD004F1-D85B-4588-A648-0A736C77D6E3",
            "start_time": "2026-07-22T11:00:00",
            "event_date": "2026-07-22",
            "documents": [],
        },
        "agenda_items": [{
            "agenda_item_id": "440691",
            "title": "Application number C 260089 PCQ (Queens CD 2 Walk to Park Site Selection/Acquisition).",
            "matters": [{
                "matter_id": "79200",
                "matter_file": "LU 0114-2026",
                "matter_url": "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79200",
                "title": "Landmarks, Queens CD 2 Walk to Park Site Selection/Acquisition, Queens (C 260089 PCQ).",
                "outcome": "Hearing Held by Committee",
                "documents": [],
                "votes": [],
            }],
        }],
    },
    "20260707021": {
        "join": {"matched": True, "method": "exact_date_body_tokens", "reason": None},
        "council_event": {
            "event_id": "22502",
            "title": "Subcommittee on Zoning and Franchises",
            "body_name": "Subcommittee on Zoning and Franchises",
            "event_url": "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22502&GID=61&G=2FD004F1-D85B-4588-A648-0A736C77D6E3",
            "start_time": "2026-07-21T11:00:00",
            "event_date": "2026-07-21",
            "documents": [],
        },
        "agenda_items": [{
            "agenda_item_id": "440690",
            "title": "Subcommittee on Zoning and Franchises agenda",
            "matters": [
                {"matter_id": "79201", "matter_file": "LU 0115-2026", "matter_url": "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79201", "title": "Zoning, 200 Kent Avenue Rezoning, Brooklyn (C 260149 ZMK).", "outcome": "Laid Over by Subcommittee", "documents": [], "votes": []},
                {"matter_id": "79203", "matter_file": "LU 0117-2026", "matter_url": "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79203", "title": "Zoning, Flatiron NoMad Major Concessions, Manhattan (C 260123 MCM).", "outcome": "Laid Over by Subcommittee", "documents": [], "votes": []},
                {"matter_id": "79202", "matter_file": "LU 0116-2026", "matter_url": "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79202", "title": "Zoning, 200 Kent Avenue Rezoning, Brooklyn (N 260150 ZRK).", "outcome": "Laid Over by Subcommittee", "documents": [], "votes": []},
                {"matter_id": "79204", "matter_file": "LU 0118-2026", "matter_url": "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79204", "title": "Zoning, 47-03 108th Street Rezoning, Queens (C 260147 ZMQ).", "outcome": "Laid Over by Subcommittee", "documents": [], "votes": []},
                {"matter_id": "79205", "matter_file": "LU 0119-2026", "matter_url": "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79205", "title": "Zoning, 47-03 108th Street Rezoning, Queens (N 260148 ZRQ).", "outcome": "Laid Over by Subcommittee", "documents": [], "votes": []},
            ],
        }],
    },
    "20260728026": {
        "join": {"matched": False, "method": None, "reason": "No Council event matched this City Record notice on the strict date + body join."},
        "council_event": None,
        "agenda_items": [],
    },
}

DOT_RULES = {
    "20260317026": {
        "request_id": "20260317026",
        "agency": "Transportation",
        "title": "DOT Proposed Rules Relating to City-Owned Bicycle Racks",
        "notice_date": "2026-03-25T00:00:00.000",
        "stage": "hearing",
        "city_record": {"request_id": "20260317026", "agency": "Transportation", "title": "DOT Proposed Rules Relating to City-Owned Bicycle Racks", "notice_date": "2026-03-25T00:00:00.000", "notice_type": "Public Hearings", "section_name": "Agency Rules", "event_date": "2026-04-24T10:00:00.000"},
        "nyc_rules": None,
        "events": [{"event_type": "public_hearing", "valid_at": "2026-04-24T10:00:00", "valid_at_precision": "instant", "valid_timezone": "UTC", "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260317026", "status": "occurred"}],
        "join": {"matched": False, "reason": "No NYC Rules entry found for this agency and notice"},
        "rulemaking_subject_ref": "rulemaking:dot:rules:https-rules.cityofnewyork.us/rule/city-owned-bicycle-racks/",
        "related_notices": [{"request_id": "20260706041", "role": "adoption", "title": "Notice of Adoption: City-Owned Bicycle Racks", "notice_date": "2026-07-14T00:00:00.000", "event_date": None, "stage": "comment-closed", "agency": "Transportation", "join": {"matched": True, "confidence": "high", "basis": "agency DOT + title-core overlap (100%) + date (111d)"}}],
        "rulemaking_join": {"matched": True, "method": "title_agency_window", "confidence": "high", "notice_count": 2, "agency": "DOT", "request_ids": ["20260317026", "20260706041"], "role": "hearing"},
    },
    "20260706041": {
        "request_id": "20260706041",
        "agency": "Transportation",
        "title": "Notice of Adoption: City-Owned Bicycle Racks",
        "notice_date": "2026-07-14T00:00:00.000",
        "stage": "comment-closed",
        "city_record": {"request_id": "20260706041", "agency": "Transportation", "title": "Notice of Adoption: City-Owned Bicycle Racks", "notice_date": "2026-07-14T00:00:00.000", "notice_type": "Notice", "section_name": "Agency Rules", "event_date": None},
        "nyc_rules": {"url": "https://rules.cityofnewyork.us/rule/dot-proposed-amendment-of-rules-relating-to-citywide-truck-routes/", "guid": "https://rules.cityofnewyork.us/rule/dot-proposed-amendment-of-rules-relating-to-citywide-truck-routes/", "pub_date": "2026-05-04T13:27:20.000Z", "title": "Citywide Truck Routes", "agency_abbr": "DOT", "agency_name": "DOT", "adoption_published_at": None, "effective_date": None, "comment_by_date": "2026-06-09", "hearing_date": "2026-06-09", "comment_url": "https://rules.cityofnewyork.us/rule/dot-proposed-amendment-of-rules-relating-to-citywide-truck-routes/", "comment_count": 353},
        "events": [{"event_type": "proposal_published", "valid_at": "2026-05-04T13:27:20.000Z", "valid_at_precision": "instant", "valid_timezone": "UTC", "source_field": "pubDate", "source_url": "https://rules.cityofnewyork.us/rule/dot-proposed-amendment-of-rules-relating-to-citywide-truck-routes/", "status": "occurred"}, {"event_type": "public_hearing", "valid_at": "2026-06-09", "valid_at_precision": "day", "valid_timezone": "America/New_York", "source_field": "hearing_date_1", "source_url": "https://rules.cityofnewyork.us/rule/dot-proposed-amendment-of-rules-relating-to-citywide-truck-routes/", "status": "occurred"}, {"event_type": "comment_close", "valid_at": "2026-06-09", "valid_at_precision": "day", "valid_timezone": "America/New_York", "source_field": "comment_by_date", "source_url": "https://rules.cityofnewyork.us/rule/dot-proposed-amendment-of-rules-relating-to-citywide-truck-routes/", "status": "occurred"}],
        "join": {"matched": True, "confidence": "medium", "basis": "agency + date proximity (70d apart)"},
        "rulemaking_subject_ref": "rulemaking:dot:rules:https-rules.cityofnewyork.us/rule/dot-proposed-amendment-of-rules-relating-to-citywide-truck-routes/",
        "related_notices": [{"request_id": "20260317026", "role": "hearing", "title": "DOT Proposed Rules Relating to City-Owned Bicycle Racks", "notice_date": "2026-03-25T00:00:00.000", "event_date": "2026-04-24T10:00:00.000", "stage": "hearing", "agency": "Transportation", "join": {"matched": True, "confidence": "high", "basis": "agency DOT + title-core overlap (100%) + date (111d)"}}],
        "rulemaking_join": {"matched": True, "method": "title_agency_window", "confidence": "high", "notice_count": 2, "agency": "DOT", "request_ids": ["20260317026", "20260706041"], "role": "adoption"},
    },
}

DOT_SODA_ROWS = [
    {"request_id": "20260317026", "start_date": "2026-03-25T00:00:00.000", "event_date": "2026-04-24T10:00:00.000", "agency_name": "Transportation", "type_of_notice_description": "Public Hearings", "section_name": "Agency Rules", "short_title": "DOT Proposed Rules Relating to City-Owned Bicycle Racks", "additional_description_1": "The Department of Transportation proposed rules relating to city-owned bicycle racks."},
    {"request_id": "20260706041", "start_date": "2026-07-14T00:00:00.000", "agency_name": "Transportation", "type_of_notice_description": "Notice", "section_name": "Agency Rules", "short_title": "Notice of Adoption: City-Owned Bicycle Racks", "additional_description_1": "Notice of adoption for City-Owned Bicycle Racks."},
]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:  # noqa: N802
        # The production edge serves canonical notice documents through the
        # same SPA shell.  Keep the loopback server on that shell after the
        # client-side hash-to-path migration.
        if self.path.split("?", 1)[0].startswith("/notices/"):
            body = (PUBLIC_SITE / "index.html").read_text(encoding="utf-8").replace(
                "<head>", '<head><base href="/">', 1
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(PUBLIC_SITE))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route: Route, body: object, status: int = 200) -> None:
    route.fulfill(status=status, content_type="application/json; charset=utf-8", body=json.dumps(body))


def install_routes(page: Page, notice_id: str | None = None) -> None:
    def api(route: Route) -> None:
        url = route.request.url
        if "/notice" in url and notice_id:
            json_response(route, {"row": MEETING_ROWS.get(notice_id) or next((r for r in DOT_SODA_ROWS if r["request_id"] == notice_id), None)})
            return
        if "/meeting-outcomes" in url and notice_id and notice_id in MEETING_OUTCOMES:
            record = MEETING_OUTCOMES[notice_id]
            json_response(route, {"ok": True, "generated_at": "2026-08-26T13:09:04.459Z", "record": {"request_id": notice_id, **record}})
            return
        if "/meeting-outcomes" in url:
            json_response(route, {"ok": False, "reason": "fixture"}, 404)
            return
        if "/rules" in url:
            json_response(route, {"schema_version": 7, "generated_at": "2026-08-16T00:00:00Z", "rules": list(DOT_RULES.values())})
            return
        json_response(route, {"ok": False, "reason": "fixture"}, 404)

    page.route("https://api.cityscroll.org/**", api)
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, [MEETING_ROWS.get(notice_id)] if notice_id and notice_id in MEETING_ROWS else DOT_SODA_ROWS))


def capture_notice(page: Page, base: str, fixture: str, notice_id: str, viewport: str) -> dict:
    install_routes(page, notice_id)
    page.add_init_script(
        """({
          const original = history.replaceState.bind(history);
          history.replaceState = (state, title, url) => {
            const text = String(url || '');
            if (/\\/notices\\/[A-Za-z0-9_-]+/.test(text)) {
              const id = text.match(/\\/notices\\/([A-Za-z0-9_-]+)/)[1];
              return original(state, title, '/index.html#notice/' + id);
            }
            return original(state, title, url);
          };
        })();"""
    )
    page.goto(f"{base}index.html#notice/{notice_id}", wait_until="domcontentloaded", timeout=45_000)
    page.locator("#noticeview .panel").wait_for(timeout=20_000)
    if fixture != "no_matter_join":
        page.locator("#nmeet .chain-h").wait_for(timeout=20_000)
    page.wait_for_timeout(500)
    path = OUT / f"{fixture}-{viewport}.png"
    page.screenshot(path=str(path), full_page=True, animations="disabled")
    return {"fixture": fixture, "route": f"#notice/{notice_id}", "viewport": viewport, "file": str(path.relative_to(ROOT))}


def capture_board(page: Page, base: str, fixture: str, board_id: str, viewport: str) -> dict:
    page.goto(f"{base}community-boards/{board_id}/", wait_until="networkidle", timeout=45_000)
    page.locator("main").wait_for(timeout=20_000)
    path = OUT / f"{fixture}-{viewport}.png"
    page.screenshot(path=str(path), full_page=True, animations="disabled")
    return {"fixture": fixture, "route": f"/community-boards/{board_id}/", "viewport": viewport, "file": str(path.relative_to(ROOT))}


def capture_rules(page: Page, base: str, viewport: str) -> dict:
    install_routes(page)
    page.goto(f"{base}index.html#rules", wait_until="domcontentloaded", timeout=45_000)
    page.locator("#rulesfeed").wait_for(timeout=20_000)
    page.wait_for_timeout(800)
    path = OUT / f"dot-bicycle-racks-rules-{viewport}.png"
    page.screenshot(path=str(path), full_page=True, animations="disabled")
    return {"fixture": "dot_bicycle_racks_rulemaking", "route": "#rules", "viewport": viewport, "file": str(path.relative_to(ROOT))}


def capture_rule_notice(page: Page, base: str, viewport: str) -> dict:
    install_routes(page, "20260706041")
    page.add_init_script(
        """(()=>{const original=history.replaceState.bind(history);history.replaceState=(s,t,u)=>{
          const text=String(u||''); const match=text.match(/\\/notices\\/([A-Za-z0-9_-]+)/);
          return match ? original(s,t,'/index.html#notice/'+match[1]) : original(s,t,u);
        }})()"""
    )
    page.goto(f"{base}index.html#notice/20260706041", wait_until="domcontentloaded", timeout=45_000)
    page.locator("#noticeview .panel").wait_for(timeout=20_000)
    page.locator("#nrules .chain-h").wait_for(timeout=20_000)
    page.wait_for_timeout(800)
    path = OUT / f"dot-bicycle-racks-lifecycle-{viewport}.png"
    page.screenshot(path=str(path), full_page=True, animations="disabled")
    return {"fixture": "dot_bicycle_racks_rulemaking", "route": "#notice/20260706041", "viewport": viewport, "file": str(path.relative_to(ROOT))}


def capture_board_map(page: Page, base: str, viewport: str) -> dict:
    page.goto(f"{base}community-boards/", wait_until="networkidle", timeout=45_000)
    page.locator('[data-view-panel="map"]').wait_for(timeout=20_000)
    path = OUT / f"cb-source-map-{viewport}.png"
    page.screenshot(path=str(path), full_page=True, animations="disabled")
    return {"fixture": "cb_source_map_surface", "route": "/community-boards/", "viewport": viewport, "file": str(path.relative_to(ROOT))}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    captures = []
    with StaticServer() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, height, viewport in VIEWPORTS:
                for fixture, notice_id in MEETING_IDS.items():
                    context = browser.new_context(viewport={"width": width, "height": height})
                    captures.append(capture_notice(context.new_page(), base, fixture, notice_id, viewport))
                    context.close()
                for fixture, board_id in (("cb_source_backed", "manhattan-cb-06"), ("cb_unknown", "manhattan-cb-02")):
                    context = browser.new_context(viewport={"width": width, "height": height})
                    captures.append(capture_board(context.new_page(), base, fixture, board_id, viewport))
                    context.close()
                context = browser.new_context(viewport={"width": width, "height": height})
                captures.append(capture_board_map(context.new_page(), base, viewport))
                context.close()
                context = browser.new_context(viewport={"width": width, "height": height})
                captures.append(capture_rules(context.new_page(), base, viewport))
                context.close()
                context = browser.new_context(viewport={"width": width, "height": height})
                captures.append(capture_rule_notice(context.new_page(), base, viewport))
                context.close()
        finally:
            browser.close()
    manifest = {"schema_version": 1, "capture_mode": "headless_playwright_loopback_static_server", "viewports": [{"name": n, "width": w, "height": h} for w, h, n in VIEWPORTS], "captures": captures}
    (OUT / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
