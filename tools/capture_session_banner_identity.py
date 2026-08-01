#!/usr/bin/env python3
"""Capture annotated before/after evidence for the recognized-session banner.

The before frame reproduces the production copy reported by the site owner. The
after frame exercises the local banner with a recognized session response. Both
use the real homepage component and project CSS; API responses are deterministic.

    python3 tools/capture_session_banner_identity.py
"""

from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import textwrap

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "session-banner-identity"
VIEWPORTS = (390, 900)
TEST_EMAIL = "@".join(("user", "example.test"))


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
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def api_response(route: Route) -> None:
    url = route.request.url
    if url.endswith("/session"):
        route.fulfill(
            status=200,
            content_type="application/json",
            body=(
                '{"ok":true,"recognized":true,'
                f'"email":"{TEST_EMAIL}",'
                '"prefsUrl":"https://api.cityscroll.org/prefs"}'
            ),
        )
    elif "/pins" in url:
        route.fulfill(
            status=200,
            content_type="application/json",
            body='{"ok":true,"recognized":true,"pins":null}',
        )
    else:
        route.fulfill(status=200, content_type="application/json", body="{}")


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
    draw.multiline_text((pad, 10), wrapped, fill="#fbf7ed", font=font, spacing=3)
    draw.rectangle(
        (2, bar_height + 2, image.width - 3, image.height + bar_height - 3),
        outline="#b84b34",
        width=3,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination)


def set_banner(page: Page, state: str) -> None:
    if state == "before":
        page.evaluate(
            """() => {
              const banner = document.getElementById('sessionBanner');
              banner.hidden = false;
              banner.dataset.open = 'true';
              document.getElementById('sessionBannerText').textContent =
                'Signed in via your email link — your pins can follow you on this device.';
              document.getElementById('sessionManage').hidden = true;
            }"""
        )
    else:
        page.evaluate(
            """(email) => {
              document.getElementById('sessionManage').hidden = false;
              sessionShowBanner({
                email,
                prefsUrl: 'https://api.cityscroll.org/prefs'
              });
            }""",
            TEST_EMAIL,
        )


def capture(page: Page, state: str, width: int) -> None:
    set_banner(page, state)
    banner = page.locator("#sessionBanner")
    banner.wait_for(state="visible")
    raw = OUTPUT / f"{state}-{width}.png"
    banner.screenshot(path=raw, animations="disabled")
    caption = (
        "BEFORE · account unspecified; “Not you?” has no referent"
        if state == "before"
        else "AFTER · email named; the same session opens Manage watches"
    )
    annotate(raw, OUTPUT / f"{state}-{width}-annotated.png", caption)
    raw.unlink()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright, StaticServer() as base:
        browser = playwright.chromium.launch(headless=True)
        for width in VIEWPORTS:
            context = browser.new_context(viewport={"width": width, "height": 820})
            page = context.new_page()
            page.route("https://api.cityscroll.org/**", api_response)
            page.route("https://data.cityofnewyork.us/**", lambda route: route.abort())
            page.goto(base, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_selector("#sessionBanner")
            capture(page, "before", width)
            capture(page, "after", width)
            context.close()
        browser.close()
    for path in sorted(OUTPUT.glob("*.png")):
        print(f"{path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
