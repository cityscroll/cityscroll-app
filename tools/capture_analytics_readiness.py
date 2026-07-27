#!/usr/bin/env python3
"""Capture annotated analytics-readiness evidence at 390px and 1440px.

The before state uses the current base branch with both public stats endpoints
returning 503. The after state uses this checkout and a deterministic aggregate
stats fixture. Captions are placed in added canvas whitespace, never over the UI.
"""

from __future__ import annotations

import functools
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import textwrap
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Browser, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "evidence"
VIEWPORTS = ((390, 844), (1440, 900))

STATS = {
    "generated": "2026-07-27T21:58:00.000Z",
    "subscriptions": {"active": 184},
    "digests": {
        "sent_last7d": 47,
        "sent_today": 8,
        "sent_all_time": 612,
        "by_category": {
            "money": 248,
            "people": 71,
            "land": 96,
            "property": 54,
            "rules": 83,
            "meetings": 42,
            "alerts": 18,
        },
    },
    "digest_clicks": {"last7d": 126},
    "feeds": {"fetches_last7d": 911},
    "batch": {"calls_last7d": 203},
    "shared_investigations": {"created_last7d": 14},
    "nl_search": {
        "calls_last7d": 358,
        "calls_today": 52,
        "calls_all_time": 4890,
        "by_category_last7d": {
            "money": 111,
            "people": 61,
            "land": 49,
            "property": 42,
            "rules": 37,
            "meetings": 33,
            "alerts": 25,
        },
        "by_category": {
            "money": 1730,
            "people": 820,
            "land": 690,
            "property": 574,
            "rules": 491,
            "meetings": 356,
            "alerts": 229,
        },
    },
    "history": {
        "digests": {
            "live_from": "2026-07-20",
            "by_day": {"2026-07-25": 6, "2026-07-26": 9, "2026-07-27": 8},
        },
        "nl_search": {
            "live_from": "2026-07-20",
            "by_day": {"2026-07-25": 44, "2026-07-26": 51, "2026-07-27": 52},
        },
        "watches_active": {
            "live_from": "2026-07-20",
            "by_day": {"2026-07-25": 176, "2026-07-26": 181, "2026-07-27": 184},
        },
    },
    "usage": {
        "available": True,
        "measured_since": "2026-07-27",
        "page_views": {"last7d": 1428, "last30d": 1428},
        "searches": {"last7d": 358, "last30d": 358},
        "deep_links": {"last7d": 287, "last30d": 287},
        "exports": {"last7d": 76, "last30d": 76},
        "alerts": {"started_last7d": 49, "confirmed_last7d": 31},
        "lens_interest": {
            "last7d": {
                "money": 421,
                "people": 203,
                "land": 185,
                "property": 142,
                "rules": 119,
                "meetings": 96,
                "alerts": 74,
            },
            "last30d": {
                "money": 421,
                "people": 203,
                "land": 185,
                "property": 142,
                "rules": 119,
                "meetings": 96,
                "alerts": 74,
            },
        },
        "geography_interest": {
            "last30d": {
                "manhattan": 146,
                "brooklyn": 291,
                "queens": 219,
                "bronx": 137,
                "staten-island": 61,
            }
        },
        "growth": {
            "by_day": {
                "2026-07-25": {"page_views": 431, "interactions": 298},
                "2026-07-26": {"page_views": 489, "interactions": 327},
                "2026-07-27": {"page_views": 508, "interactions": 344},
            }
        },
    },
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
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


def revision_snapshot(revision: str, destination: Path) -> None:
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)


def install_routes(page: Page, state: str) -> None:
    def external(route: Route) -> None:
        url = route.request.url
        if url.endswith("/stats"):
            if state == "before":
                route.fulfill(
                    status=503,
                    body="unavailable",
                    headers={"Access-Control-Allow-Origin": "*"},
                )
            else:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(STATS),
                    headers={"Access-Control-Allow-Origin": "*"},
                )
        elif url.endswith("/events"):
            route.fulfill(status=204, body="")
        elif url.startswith("https://"):
            route.abort()
        else:
            route.continue_()

    page.route("**/*", external)


def prepare(page: Page, base_url: str, state: str) -> dict[str, float]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    install_routes(page, state)
    page.goto(base_url + "stats.html", wait_until="domcontentloaded")
    if state == "before":
        page.wait_for_function(
            "() => document.querySelector('#msg')?.textContent.includes('unreachable')"
        )
        assert page.locator("#s-subs").text_content() == "–"
    else:
        page.wait_for_function(
            "() => document.querySelector('#s-subs')?.textContent === '184'"
        )
        assert page.locator("#s-digests").text_content() == "47"
        assert page.locator("#s-nl").text_content() == "358"

    page.evaluate(
        """() => {
          const target = document.querySelector("#grid");
          window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + scrollY - 130));
        }"""
    )
    page.wait_for_timeout(150)
    box = page.locator("#grid").bounding_box()
    if box is None:
        raise AssertionError(f"{state} headline grid is not renderable")
    if errors:
        raise AssertionError(f"{state} page errors: {errors}")
    return box


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    )
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default(size=size)


def annotate(
    source: Path,
    destination: Path,
    state: str,
    target: dict[str, float],
) -> None:
    screenshot = Image.open(source).convert("RGB")
    color = (151, 35, 35) if state == "before" else (27, 105, 64)
    title = "BEFORE · ENDPOINT FAILURE" if state == "before" else "AFTER · RESILIENT STATS"
    detail = (
        "The three headline panels have no values. The same failure also left "
        "the supporting stats surface empty."
        if state == "before"
        else "The same headline panels now show values and per-panel as-of "
        "provenance; supporting aggregate panels are filled below."
    )
    title_font = font(17 if screenshot.width >= 700 else 14)
    body_font = font(15 if screenshot.width >= 700 else 12)
    wrap_width = 90 if screenshot.width >= 700 else 47
    detail_lines = "\n".join(textwrap.wrap(detail, width=wrap_width))
    body_box = ImageDraw.Draw(screenshot).multiline_textbbox(
        (0, 0), detail_lines, font=body_font, spacing=3
    )
    caption_height = max(94, body_box[3] - body_box[1] + 62)

    canvas = Image.new(
        "RGB",
        (screenshot.width, screenshot.height + caption_height),
        (248, 244, 235),
    )
    canvas.paste(screenshot, (0, caption_height))
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.rectangle((0, 0, screenshot.width, caption_height), fill=(248, 244, 235, 255))
    draw.rectangle((0, 0, 9, caption_height), fill=(*color, 255))
    draw.text((24, 16), title, font=title_font, fill=(*color, 255))
    draw.multiline_text(
        (24, 43),
        detail_lines,
        font=body_font,
        fill=(36, 32, 28, 255),
        spacing=3,
    )

    x1 = max(3, target["x"] - 8)
    y1 = max(caption_height + 3, caption_height + target["y"] - 8)
    x2 = min(screenshot.width - 3, target["x"] + target["width"] + 8)
    y2 = min(
        canvas.height - 3,
        caption_height + target["y"] + target["height"] + 8,
    )
    draw.rounded_rectangle((x1, y1, x2, y2), radius=9, outline=(*color, 255), width=5)
    canvas.save(destination, optimize=True)


def capture_state(
    browser: Browser,
    tree: Path,
    state: str,
    width: int,
    height: int,
    temp: Path,
) -> None:
    with StaticServer(tree) as base_url:
        page = browser.new_page(viewport={"width": width, "height": height})
        target = prepare(page, base_url, state)
        raw = temp / f"{state}-{width}.png"
        page.screenshot(path=raw, animations="disabled")
        destination = OUTPUT / f"analytics-readiness-{state}-{width}-annotated.png"
        annotate(raw, destination, state, target)
        assert destination.stat().st_size > 10_000
        page.close()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-analytics-evidence-") as temp_name:
        temp = Path(temp_name)
        before_tree = temp / "before"
        before_tree.mkdir()
        revision_snapshot("origin/main", before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in VIEWPORTS:
                    capture_state(browser, before_tree, "before", width, height, temp)
                    capture_state(browser, ROOT, "after", width, height, temp)
            finally:
                browser.close()

    for asset in sorted(OUTPUT.glob("analytics-readiness-*-annotated.png")):
        print(f"{asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
