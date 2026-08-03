#!/usr/bin/env python3
"""Capture the reported rule notice's comment action before and after URL normalization."""

from __future__ import annotations

import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "action-link-integrity"
NOTICE_ID = "20260715041"
RULE_URL = "https://rules.cityofnewyork.us/rule/amendments-related-to-the-nyc-energy-conservation-code/"
FEED_URL = f"{RULE_URL}feed/"
VIEWPORTS = ((390, 844), (1440, 900))

NOTICE = {
    "request_id": NOTICE_ID,
    "start_date": "2026-07-23T00:00:00.000",
    "end_date": "2026-07-23T00:00:00.000",
    "agency_name": "Buildings",
    "type_of_notice_description": "Public Hearings",
    "short_title": "Amendments to Rules Relating to the Energy Conservation Code",
    "section_name": "Agency Rules",
    "event_date": "2026-08-27T11:00:00.000",
}


def rule_record(comment_url: str) -> dict:
    return {
        "request_id": NOTICE_ID,
        "agency": "Buildings",
        "title": NOTICE["short_title"],
        "notice_date": NOTICE["start_date"],
        "stage": "comment-open",
        "city_record": {
            "request_id": NOTICE_ID,
            "agency": "Buildings",
            "title": NOTICE["short_title"],
            "notice_date": NOTICE["start_date"],
            "notice_type": "Public Hearings",
            "section_name": "Agency Rules",
            "event_date": NOTICE["event_date"],
        },
        "nyc_rules": {
            "url": RULE_URL,
            "guid": RULE_URL,
            "pub_date": "2026-07-23T14:08:48.000Z",
            "title": "Amendments Related to the NYC Energy Conservation Code",
            "agency_abbr": "DOB",
            "agency_name": "DOB",
            "comment_by_date": "2026-08-27",
            "hearing_date": "2026-08-27",
            "comment_url": comment_url,
            "comment_count": 7,
            "summary": (
                "The Department of Buildings is proposing amendments related to "
                "the New York City Energy Conservation Code."
            ),
        },
        "events": [
            {
                "event_type": "proposal_published",
                "valid_at": "2026-07-23T14:08:48.000Z",
                "valid_at_precision": "instant",
                "valid_timezone": "UTC",
                "source_url": RULE_URL,
                "status": "occurred",
            },
            {
                "event_type": "public_hearing",
                "valid_at": "2026-08-27",
                "valid_at_precision": "day",
                "valid_timezone": "America/New_York",
                "source_url": RULE_URL,
                "status": "scheduled",
            },
            {
                "event_type": "comment_close",
                "valid_at": "2026-08-27",
                "valid_at_precision": "day",
                "valid_timezone": "America/New_York",
                "source_url": RULE_URL,
                "status": "scheduled",
            },
        ],
        "join": {"matched": True, "confidence": "high", "basis": "fixture"},
        "related_notices": [],
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


def install_routes(page: Page, record: dict) -> None:
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
            {"schema_version": 6, "generated_at": "2026-08-03T10:00:00Z", "rules": [record]},
        ),
    )


def annotate(page: Page, label: str) -> None:
    page.evaluate(
        """label => {
          const target = document.querySelector('.next-action-rail a.primary')
            || document.querySelector('.next-action-rail a');
          if (!target) throw new Error('comment action not found');
          const box = target.getBoundingClientRect();
          const noteLeft = innerWidth < 600 ? 8 : Math.max(8, box.left);
          const note = document.createElement('div');
          note.textContent = label;
          Object.assign(note.style, {
            position: 'fixed', left: `${noteLeft}px`,
            top: `${Math.max(58, box.top - 78)}px`,
            width: `${Math.min(innerWidth - noteLeft - 8, Math.max(330, box.width))}px`,
            background: '#161616', color: '#fff', borderLeft: '6px solid #ffbd00',
            padding: '10px 12px', borderRadius: '5px', zIndex: '99999',
            font: '700 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
            overflowWrap: 'anywhere', boxSizing: 'border-box'
          });
          const mark = document.createElement('div');
          Object.assign(mark.style, {
            position: 'fixed', left: `${Math.max(4, box.left - 5)}px`,
            top: `${Math.max(4, box.top - 5)}px`, width: `${box.width + 10}px`,
            height: `${box.height + 10}px`, border: '4px solid #ffbd00',
            borderRadius: '7px', zIndex: '99998', pointerEvents: 'none',
            boxSizing: 'border-box'
          });
          document.body.append(mark, note);
        }""",
        label,
    )


def capture(page: Page, base: str, state: str, comment_url: str, status: int) -> None:
    install_routes(page, rule_record(comment_url))
    page.goto(f"{base}#notice/{NOTICE_ID}", wait_until="domcontentloaded", timeout=45_000)
    action = page.locator(".next-action-rail a.primary").first
    action.wait_for(timeout=20_000)
    assert action.get_attribute("href") == comment_url
    page.add_style_tag(content="#noticeview .panel > .note:last-child{display:none!important}")
    action.scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    annotation = f"{state.title()} · COMMENT href → {comment_url} · HTTP {status}"
    annotate(page, annotation)
    page.screenshot(path=OUT / f"{state}-{page.viewport_size['width']}.png", animations="disabled")


def http_status(url: str) -> int:
    request = Request(
        url,
        method="HEAD",
        headers={"User-Agent": "CityScrollEvidenceCapture/1.0 (+https://cityscroll.org)"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            return response.status
    except HTTPError as error:
        return error.code


def main() -> None:
    statuses = {"before": http_status(FEED_URL), "after": http_status(RULE_URL)}  # Source: live NYC Rules HEAD probes.
    assert statuses == {"before": 404, "after": 200}, statuses
    OUT.mkdir(parents=True, exist_ok=True)

    with StaticServer() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in VIEWPORTS:
            for state, url in (("before", FEED_URL), ("after", RULE_URL)):
                context = browser.new_context(viewport={"width": width, "height": height})
                capture(context.new_page(), base, state, url, statuses[state])
                context.close()
        browser.close()

    receipt = {
        "notice_id": NOTICE_ID,
        "source": "NYC Open Data City Record Online (dg92-zbpx) and NYC Rules RSS",
        "captured_at": "2026-08-03",
        "before": {"comment_url": FEED_URL, "http_status": statuses["before"]},
        "after": {"comment_url": RULE_URL, "http_status": statuses["after"]},
        "viewports": [width for width, _height in VIEWPORTS],
    }
    (OUT / "capture-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote action-link evidence to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
