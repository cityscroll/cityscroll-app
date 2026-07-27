#!/usr/bin/env python3
"""Capture plain and annotated whole-profile evidence at 390px and 1440px.

The before frame renders the previously shipped instant identity header with its
three live-hydration skeletons. The after frame exercises showVendor() against a
mocked complete bucket and asserts that the paint makes no Socrata request.
"""

from __future__ import annotations

import functools
import json
import textwrap
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "review" / "profile-fully-instant"
VIEWPORTS = ((390, 844), (1440, 900))

VARIANTS = [
    ("CAMBA", 3, 11800080, "2008-03-10", "2011-05-02"),
    ("Camba Inc.", 135, 1106326956.53, "2010-10-05", "2025-07-31"),
    ("Camba, Inc", 7, 85947407.33, "2016-01-28", "2020-11-04"),
    ("CAMBA Inc", 9, 147676229, "2026-05-13", "2026-07-27"),
    ("CAMBA  Inc", 17, 141415368.94, "2019-07-12", "2022-12-07"),
    ("CAMBA, Inc.", 92, 352563435.1, "2007-09-14", "2026-03-18"),
    ("CAMBA, Inc.,", 4, 9496422, "2012-06-13", "2022-06-06"),
    ("CAMBA. Inc.", 2, 61057155, "2015-09-03", "2021-07-21"),
    ("CAMBA., Inc.", 2, 30033469, "2010-05-12", "2022-07-08"),
]

PROFILE = {
    "stem": "CAMBA",
    "display": "Camba Inc.",
    "variants": [
        {"name": name, "n": n, "total": total, "first": first, "last": last}
        for name, n, total, first, last in VARIANTS
    ],
    "awardCount": 271,
    "total": 1946316522.9,
    "first": "2007-09-14",
    "last": "2026-07-27",
    "topAgencies": [
        {"name": "Human Resources Administration", "n": 140, "total": 1100000000},
        {"name": "Homeless Services", "n": 131, "total": 846316522.9},
    ],
    "recentNotices": [
        {
            "request_id": f"camba-{i + 1}",
            "start_date": f"2026-07-{27 - i:02d}",
            "agency_name": "Human Resources Administration" if i % 2 else "Homeless Services",
            "type_of_notice_description": "Award",
            "short_title": f"Community services contract award {i + 1}",
            "contract_amount": (i + 1) * 125000,
        }
        for i in range(15)
    ],
    "forecasts": [
        {
            "source": "checkbook",
            "vendor_name": "Camba Inc.",
            "agency_name": "Homeless Services",
            "amount": 2000000,
            "expiration_date": "2027-03-01",
        }
    ],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT))
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


def install_fixtures(page: Page) -> None:
    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route(
        "**/vendor-profile?**",
        lambda route: json_response(
            route,
            {
                "ok": True,
                "generated": "2026-07-27T13:00:00.000Z",
                "profile": PROFILE,
            },
        ),
    )
    page.add_init_script(
        """
        (() => {
          const nativeFetch = window.fetch.bind(window);
          window.__socrataCalls = [];
          window.fetch = (input, init) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes("data.cityofnewyork.us")) window.__socrataCalls.push(url);
            return nativeFetch(input, init);
          };
          window.turnstile = {getResponse: () => "", reset: () => {}};
        })();
        """
    )


def annotate(source: Path, destination: Path, state: str, target: dict[str, float]) -> None:
    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    color = (155, 48, 48, 255) if state == "before" else (35, 112, 83, 255)
    message = (
        "Before: the profile tail waits on live requests and shows skeleton rows."
        if state == "before"
        else "After: recent notices paint from the daily bucket with its as-of stamp."
    )
    font = ImageFont.load_default(size=18 if image.width >= 700 else 15)
    label = "\n".join(textwrap.wrap(message, width=66 if image.width >= 700 else 38))
    text_box = draw.multiline_textbbox((0, 0), label, font=font, spacing=4)
    banner_height = text_box[3] - text_box[1] + 24
    draw.rounded_rectangle(
        (10, 10, image.width - 10, 10 + banner_height),
        radius=10,
        fill=(28, 25, 22, 238),
        outline=color,
        width=3,
    )
    draw.multiline_text((22, 22), label, font=font, fill=(255, 255, 255, 255), spacing=4)

    x1 = max(2, target["x"] - 7)
    y1 = max(2, target["y"] - 6)
    x2 = min(image.width - 2, target["x"] + target["width"] + 7)
    y2 = min(image.height - 2, target["y"] + target["height"] + 6)
    draw.rounded_rectangle((x1, y1, x2, y2), radius=7, outline=color, width=4)
    image.save(destination, optimize=True)


def skeleton_target(page: Page) -> dict[str, float]:
    return page.evaluate(
        """
        () => {
          const el = document.querySelector("#vendor-live");
          window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 125));
          const rect = el.getBoundingClientRect();
          return {x:rect.x, y:rect.y, width:rect.width, height:rect.height};
        }
        """
    )


def instant_tail_target(page: Page) -> dict[str, float]:
    return page.evaluate(
        """
        () => {
          const rows = [...document.querySelectorAll("#overview-content .timeline .tl")];
          const start = rows[Math.max(0, rows.length - 3)];
          const asOf = document.querySelector("#entityview .panel > .rmeta");
          window.scrollTo(0, Math.max(0, start.getBoundingClientRect().top + scrollY - 125));
          const first = start.getBoundingClientRect();
          const last = asOf.getBoundingClientRect();
          return {
            x: Math.min(first.x, last.x),
            y: first.y,
            width: Math.max(first.right, last.right) - Math.min(first.x, last.x),
            height: last.bottom - first.y
          };
        }
        """
    )


def capture(page: Page, base_url: str, width: int, height: int) -> None:
    page.goto(f"{base_url}#vendor/Camba%20Inc.", wait_until="domcontentloaded")
    page.wait_for_function("typeof renderVendorProfile === 'function'")
    page.evaluate(
        """
        profile => {
          showTab("entity");
          renderVendorProfile(document.querySelector("#entityview"), profile, null, null, true);
        }
        """,
        PROFILE,
    )
    before_target = skeleton_target(page)
    before = OUTPUT / f"before-{width}.png"
    page.screenshot(path=str(before), animations="disabled")
    annotate(
        before,
        OUTPUT / f"before-{width}-annotated.png",
        "before",
        before_target,
    )

    page.evaluate(
        """
        () => {
          window.__socrataCalls = [];
          void showVendor("Camba Inc.");
        }
        """
    )
    page.wait_for_function(
        """
        () => document.querySelectorAll("#overview-content .timeline .tl").length === 15
          && !document.querySelector("#overview-content .loading")
        """,
        timeout=1000,
    )
    assert page.evaluate("window.__socrataCalls.length") == 0
    after_target = instant_tail_target(page)
    after = OUTPUT / f"after-{width}.png"
    page.screenshot(path=str(after), animations="disabled")
    annotate(
        after,
        OUTPUT / f"after-{width}-annotated.png",
        "after",
        after_target,
    )

    assert before.stat().st_size > 10_000
    assert after.stat().st_size > 10_000
    assert (OUTPUT / f"before-{width}-annotated.png").stat().st_size > 10_000
    assert (OUTPUT / f"after-{width}-annotated.png").stat().st_size > 10_000
    print(f"captured {before.relative_to(ROOT)}")
    print(f"captured {(OUTPUT / f'before-{width}-annotated.png').relative_to(ROOT)}")
    print(f"captured {after.relative_to(ROOT)}")
    print(f"captured {(OUTPUT / f'after-{width}-annotated.png').relative_to(ROOT)}")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                install_fixtures(page)
                capture(page, base_url, width, height)
                page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
