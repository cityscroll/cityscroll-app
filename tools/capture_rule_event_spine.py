#!/usr/bin/env python3
"""Capture before/after Rules lifecycle spine screenshots on notice detail.

The browser runs the real public ``site/index.html`` and intercepts only its data
requests with deterministic, live-shaped City Record and ``/rules`` fixtures.

States:
  - before: ``/rules`` returns no join for the notice (no timeline cards filled)
  - after:  full event spine with proposal / hearing / comment close (and gap cards)

    python3 tools/capture_rule_event_spine.py
    python3 tools/capture_rule_event_spine.py --out artifacts/cs-time-02
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
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "rule-event-spine"
NOTICE_ID = "CR-RULE-SPINE-001"
VIEWPORTS = ((390, 844), (1440, 900))

NOTICE = {
    "request_id": NOTICE_ID,
    "start_date": "2026-07-23T00:00:00.000",
    "agency_name": "Department of Transportation",
    "section_name": "Agency Rules",
    "type_of_notice_description": "Agency Rules",
    "short_title": "Commercial Meter Parking for For-Hire Vehicles",
    "additional_description_1": (
        "The Department of Transportation proposes to amend rules governing "
        "commercial parking meters. The public may submit comments through NYC Rules."
    ),
}

RULE_RECORD_AFTER = {
    "request_id": NOTICE_ID,
    "agency": NOTICE["agency_name"],
    "title": NOTICE["short_title"],
    "notice_date": NOTICE["start_date"],
    "stage": "comment-open",
    "nyc_rules": {
        "url": "https://rules.cityofnewyork.us/rule/meter-parking/",
        "comment_url": "https://rules.cityofnewyork.us/rule/meter-parking/#comments",
        "comment_by_date": "2026-09-01",
        "hearing_date": "2026-08-27",
        "adoption_published_at": None,
        "effective_date": None,
    },
    "events": [
        {
            "event_type": "proposal_published",
            "valid_at": "2026-07-23T16:18:07.000Z",
            "valid_at_precision": "instant",
            "valid_timezone": "UTC",
            "status": "occurred",
        },
        {
            "event_type": "public_hearing",
            "valid_at": "2026-08-27",
            "valid_at_precision": "day",
            "valid_timezone": "America/New_York",
            "status": "scheduled",
        },
        {
            "event_type": "comment_close",
            "valid_at": "2026-09-01",
            "valid_at_precision": "day",
            "valid_timezone": "America/New_York",
            "status": "scheduled",
            "alert": {"eligible": True, "trigger_field": "valid_at", "lead_days": [14, 3, 1, 0]},
        },
    ],
    "join": {"matched": True, "confidence": "high", "basis": "fixture"},
}

RULE_RECORD_BEFORE = {
    "request_id": NOTICE_ID,
    "agency": NOTICE["agency_name"],
    "title": NOTICE["short_title"],
    "notice_date": NOTICE["start_date"],
    "stage": "proposed",
    "nyc_rules": None,
    "events": [],
    "join": {"matched": False, "reason": "fixture before-state: no join"},
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


def annotate(page: Page, selector: str, label: str) -> None:
    page.evaluate(
        """({selector,label}) => {
          const t=document.querySelector(selector);
          if(!t) return;
          const rect=t.getBoundingClientRect();
          const left=Math.max(5,rect.left-6), top=Math.max(48,rect.top-6);
          const width=Math.min(innerWidth-left-5,rect.width+12);
          const mark=document.createElement("div");
          Object.assign(mark.style,{position:"fixed",left:`${left}px`,top:`${top}px`,
            width:`${width}px`,height:`${Math.max(rect.height,24)+12}px`,border:"4px solid #d60000",
            borderRadius:"8px",boxSizing:"border-box",zIndex:"99998",pointerEvents:"none"});
          const note=document.createElement("div");
          note.textContent=label;
          Object.assign(note.style,{position:"fixed",left:`${left}px`,top:`${Math.max(5,top-43)}px`,
            maxWidth:`${Math.max(width,180)}px`,background:"#d60000",color:"#fff",padding:"7px 10px",
            borderRadius:"5px",font:"800 12px/1.25 system-ui,sans-serif",zIndex:"99999",
            pointerEvents:"none"});
          document.body.append(mark,note);
        }""",
        {"selector": selector, "label": label},
    )


def install_routes(page: Page, rule_record: dict) -> None:
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
            {"schema_version": 2, "generated_at": "2026-08-01T12:00:00Z", "rules": [rule_record]},
        ),
    )


def capture_state(playwright, base: str, out: Path, state: str, rule_record: dict) -> None:
    for width, height in VIEWPORTS:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        install_routes(page, rule_record)

        page.goto(f"{base}#notice/{NOTICE_ID}", wait_until="domcontentloaded", timeout=45_000)
        spine = page.locator("#nrules")
        spine.locator(".chain-h").wait_for(timeout=20_000)

        if state == "after":
            assert spine.get_by_text("Comment deadline", exact=True).count() == 1
            assert spine.get_by_text("Effective", exact=True).count() == 1
            assert spine.get_by_text("The city has not published").count() == 2
            assert spine.get_by_text("Comments due", exact=False).count() >= 1
        else:
            # Unjoined notice: all five stages show the class-(a) not-yet-ingested gap.
            assert spine.get_by_text("Not yet shown here", exact=False).count() >= 4
            assert spine.get_by_text("Comment deadline", exact=True).count() == 1

        overflow = page.evaluate(
            """() => ({
              page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              spine: document.querySelector('#nrules').scrollWidth > document.querySelector('#nrules').clientWidth
            })"""
        )
        assert overflow == {"page": False, "spine": False}, overflow

        page.evaluate("document.querySelector('#nrules')?.scrollIntoView({block:'center'})")
        page.wait_for_timeout(200)

        raw = out / f"{state}-{width}.png"
        page.screenshot(path=str(raw), animations="disabled")
        label = (
            "Rules lifecycle spine (comment deadline + hearing)"
            if state == "after"
            else "Before: Agency Rules notice without lifecycle join"
        )
        annotate(page, "#nrules", label)
        ann = out / f"{state}-{width}-annotated.png"
        page.screenshot(path=str(ann), animations="disabled")

        # Keep legacy names for the after state (docs / AGENTS.md links).
        if state == "after":
            spine.screenshot(path=str(out / f"rule-event-spine-{width}.png"))

        context.close()
        browser.close()
        print(f"  {raw.relative_to(ROOT) if raw.is_relative_to(ROOT) else raw}")


def capture(out: Path | None = None) -> Path:
    target = out or DEFAULT_OUT
    target.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base, sync_playwright() as playwright:
        print("Capturing before (no Rules join)...")
        capture_state(playwright, base, target, "before", RULE_RECORD_BEFORE)
        print("Capturing after (Rules event spine)...")
        capture_state(playwright, base, target, "after", RULE_RECORD_AFTER)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Screenshot directory (default: docs/screenshots/rule-event-spine)",
    )
    args = parser.parse_args()
    target = capture(args.out.resolve() if args.out else None)
    for image in sorted(target.glob("*.png")):
        rel = image.relative_to(ROOT) if image.is_relative_to(ROOT) else image
        print(f"{rel} ({image.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
