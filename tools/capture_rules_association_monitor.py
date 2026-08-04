#!/usr/bin/env python3
"""Before/after capture: rules association monitor pack.

Frames (each at 390 and 1440):
  templates   #alerts?template=restaurants — multi-watch pack registry
  bands       #rules — action-banded list grouping
  notice      #notice/… — shepherded participation + member blurb

  python3 tools/capture_rules_association_monitor.py
  CROL_ASSOC_LABEL=before python3 tools/capture_rules_association_monitor.py
"""

from __future__ import annotations

import functools
import json
import os
import textwrap
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LABEL = os.environ.get("CROL_ASSOC_LABEL", "after")
OUT = Path(
    os.environ.get(
        "CROL_ASSOC_OUT",
        str(ROOT / "docs" / "screenshots" / "rules-association-monitor"),
    )
)
SITE = Path(os.environ.get("CROL_ASSOC_ROOT", str(ROOT / "site")))
VIEWPORTS = ((390, 844), (1440, 900))

# Fixture notices for hermetic screenshots only.
# request_id / agency / titles are shaped like City Record Online Agency Rules rows
# (dataset dg92-zbpx); stage + nyc_rules dates are product fixtures for capture, not a live export.
NOTICES = [
    {
        "request_id": "20260706044",
        "start_date": "2026-07-06T00:00:00.000",
        "agency_name": "Taxi and Limousine Commission",
        "section_name": "Agency Rules",
        "type_of_notice_description": "Proposed Rule Making",
        "short_title": "Driver Relief Penalty Reduction and Medallion Relief Program Rule Proposal.",
        "additional_description_1": (
            "The Taxi and Limousine Commission proposes rules reducing certain "
            "driver penalties and extending medallion relief terms for eligible licensees."
        ),
        "event_date": None,
    },
    {
        "request_id": "20260707025",
        "start_date": "2026-07-07T00:00:00.000",
        "agency_name": "Buildings",
        "section_name": "Agency Rules",
        "type_of_notice_description": "Adoption of Rules",
        "short_title": "Final Rule - Amendment of Rules relating to Sidewalk Sheds",
        "additional_description_1": (
            "The Department of Buildings adopts amendments to sidewalk shed design "
            "and inspection requirements for construction sites."
        ),
        "event_date": None,
    },
    {
        "request_id": "20260618004",
        "start_date": "2026-06-18T00:00:00.000",
        "agency_name": "Health and Mental Hygiene",
        "section_name": "Agency Rules",
        "type_of_notice_description": "Proposed Rule Making",
        "short_title": "Proposed Amendments to Food Service Establishment Rules",
        "additional_description_1": (
            "DOHMH proposes amendments to food service establishment sanitary rules "
            "affecting restaurants and caterers citywide."
        ),
        "event_date": None,
    },
]

RULES_VIEW = {
    "generated_at": "2026-07-01T12:00:00Z",
    "rules": [
        {
            "request_id": "20260706044",
            "agency": "Taxi and Limousine Commission",
            "title": NOTICES[0]["short_title"],
            "stage": "comment-open",
            "join": {"matched": True},
            "nyc_rules": {
                "url": "https://rules.cityofnewyork.us/tlc-relief",
                "comment_url": "https://rules.cityofnewyork.us/tlc-relief#comment",
                "comment_by_date": "2026-07-25",
            },
            "events": [
                {
                    "event_type": "proposal_published",
                    "valid_at": "2026-07-06",
                    "status": "occurred",
                    "source_url": "https://rules.cityofnewyork.us/tlc-relief",
                },
                {
                    "event_type": "comment_close",
                    "valid_at": "2026-07-25",
                    "status": "scheduled",
                    "source_url": "https://rules.cityofnewyork.us/tlc-relief#comment",
                },
            ],
        },
        {
            "request_id": "20260707025",
            "agency": "Buildings",
            "title": NOTICES[1]["short_title"],
            "stage": "adopted",
            "join": {"matched": True},
            "nyc_rules": {
                "url": "https://rules.cityofnewyork.us/dob-sheds",
                "effective_date": "2026-09-01",
                "adoption_published_at": "2026-07-07",
            },
            "events": [
                {
                    "event_type": "adoption",
                    "valid_at": "2026-07-07",
                    "status": "occurred",
                    "source_url": "https://rules.cityofnewyork.us/dob-sheds",
                },
                {
                    "event_type": "effective",
                    "valid_at": "2026-09-01",
                    "status": "scheduled",
                    "source_url": "https://rules.cityofnewyork.us/dob-sheds",
                },
            ],
        },
        {
            "request_id": "20260618004",
            "agency": "Health and Mental Hygiene",
            "title": NOTICES[2]["short_title"],
            "stage": "comment-open",
            "join": {"matched": True},
            "nyc_rules": {
                "url": "https://rules.cityofnewyork.us/dohmh-fse",
                "comment_url": "https://rules.cityofnewyork.us/dohmh-fse#comment",
                "comment_by_date": "2026-08-01",
                "hearing_date": "2026-07-22",
            },
            "events": [
                {
                    "event_type": "proposal_published",
                    "valid_at": "2026-06-18",
                    "status": "occurred",
                    "source_url": "https://rules.cityofnewyork.us/dohmh-fse",
                },
                {
                    "event_type": "public_hearing",
                    "valid_at": "2026-07-22",
                    "status": "scheduled",
                    "source_url": "https://rules.cityofnewyork.us/dohmh-fse",
                },
                {
                    "event_type": "comment_close",
                    "valid_at": "2026-08-01",
                    "status": "scheduled",
                    "source_url": "https://rules.cityofnewyork.us/dohmh-fse#comment",
                },
            ],
        },
    ],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def annotate(source: Path, destination: Path, caption: str) -> None:
    image = Image.open(source).convert("RGB")
    font = ImageFont.load_default(size=15)
    pad = 14
    wrapped = textwrap.fill(caption, width=max(24, (image.width - 2 * pad) // 8))
    lines = wrapped.count("\n") + 1
    bar_height = 28 + (lines * 18)
    canvas = Image.new("RGB", (image.width, image.height + bar_height), "#1a1714")
    canvas.paste(image, (0, bar_height))
    draw = ImageDraw.Draw(canvas)
    draw.text((pad, 10), wrapped, fill="#f4efe4", font=font)
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, optimize=True)


def install_routes(page: Page) -> None:
    def on_route(route: Route) -> None:
        from urllib.parse import parse_qs, unquote, urlparse

        url = route.request.url
        if "data.cityofnewyork.us/resource/dg92-zbpx" in url:
            qs = parse_qs(urlparse(url).query)
            where = unquote((qs.get("$where") or [""])[0])
            # Fixture slice of NOTICES (City Record-shaped capture rows declared above).
            matched = next(
                (row for row in NOTICES if f"request_id='{row['request_id']}'" in where),
                None,
            )
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps([matched] if matched is not None else NOTICES),
            )
            return
        # Worker /rules materialization only (never app modules like site/app/rules.mjs).
        path = urlparse(url).path.rstrip("/")
        if path.endswith("/rules") or path.endswith("/rules.json"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(RULES_VIEW),
            )
            return
        route.continue_()

    page.route("**/*", on_route)


def capture(
    page: Page,
    base: str,
    name: str,
    hash_path: str,
    wait_sel: str,
    caption: str,
    width: int,
    height: int,
    before_css: str | None = None,
    after_click: str | None = None,
    panel_sel: str | None = None,
) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base}index.html{hash_path}", wait_until="domcontentloaded")
    if panel_sel:
        page.wait_for_selector(panel_sel, timeout=30_000, state="visible")
    # Before frames may hide feature chrome; wait for attachment not visibility.
    state = "attached" if (LABEL == "before" and before_css) else "visible"
    page.wait_for_selector(wait_sel, timeout=30_000, state=state)
    if LABEL == "before" and before_css:
        page.add_style_tag(content=before_css)
    if LABEL != "before" and after_click:
        try:
            page.click(after_click, timeout=8_000)
            page.wait_for_timeout(500)
        except Exception:
            pass
    page.wait_for_timeout(800)
    raw = OUT / f"{LABEL}-{name}-{width}-raw.png"
    raw.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(raw), full_page=False)
    annotate(raw, OUT / f"{LABEL}-{name}-{width}.png", caption)
    raw.unlink(missing_ok=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with StaticServer(SITE) as base, sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        install_routes(page)

        for w, h in VIEWPORTS:
            capture(
                page,
                base,
                "templates",
                "#alerts?template=restaurants",
                "#watch-templates",
                "Association monitor packs: curated multi-watch templates on Alerts.",
                w,
                h,
                before_css="#watch-templates{display:none !important}",
                after_click='#watch-template-list .watch-tpl-card[data-tpl-id="restaurants"]',
                panel_sel="#tab-alerts.tabpane.active, #tab-alerts.active, #quizpanel",
            )
            capture(
                page,
                base,
                "bands",
                "#rules",
                "#rulesfeed .fcard, #rulesfeed .rules-fcard, #rulesfeed .empty, #rulesfeed .rules-action-band",
                "Rules lens grouped by action band (comment open / hearing / adopted).",
                w,
                h,
                before_css=".rules-action-band{display:none !important}",
                panel_sel="#tab-rules.tabpane.active, #tab-rules.active, #rulesfeed",
            )
            capture(
                page,
                base,
                "notice",
                "#notice/20260706044",
                "#nrules, #noticeview",
                "Open-comment rule: shepherded participation path + forwardable member blurb.",
                w,
                h,
                before_css=".rule-participation,.rule-member-blurb{display:none !important}",
                panel_sel="#tab-notice.tabpane.active, #tab-notice.active, #noticeview",
            )

        browser.close()
    print(f"wrote screenshots under {OUT} (label={LABEL})")


if __name__ == "__main__":
    main()
