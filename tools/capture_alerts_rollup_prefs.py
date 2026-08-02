#!/usr/bin/env python3
"""Capture the multi-watch digest rollup + prefs surface on #alerts.

Serves site/ statically, opens #alerts?view=rollup (hermetic fixture — no
live SUBS/API), and writes annotated frames under docs/screenshots/alerts-rollup-prefs/.

    python3 tools/capture_alerts_rollup_prefs.py
"""

from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import textwrap

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "alerts-rollup-prefs"
VIEWPORTS = ((390, 844), (1440, 900))


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


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base, sync_playwright() as p:
        browser = p.chromium.launch()
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(f"{base}index.html#alerts?view=rollup", wait_until="domcontentloaded")
            page.wait_for_selector("#alerts-rollup-prefs", timeout=15_000)
            page.wait_for_selector("#alerts-rollup-emailmock .emailmock", timeout=15_000)
            page.wait_for_selector("#alerts-rollup-groups .rollup-group", timeout=15_000)
            # Scroll rollup panel into view for mobile capture.
            page.locator("#alerts-rollup-prefs").scroll_into_view_if_needed()
            page.wait_for_timeout(300)
            raw = OUTPUT / f"rollup-{width}x{height}-raw.png"
            page.screenshot(path=str(raw), full_page=False)
            annotate(
                raw,
                OUTPUT / f"rollup-{width}x{height}.png",
                "Multi-watch rollup: group by topic/agency/geo + consolidated digest mock + prefs manage path.",
            )
            raw.unlink(missing_ok=True)
            page.close()
        browser.close()
    print(f"wrote captures under {OUTPUT}")


if __name__ == "__main__":
    main()
