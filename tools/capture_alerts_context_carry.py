#!/usr/bin/env python3
"""Before/after capture: notice → context-carrying alert entry.

Serves site/ statically. Frames:
  - before: bare #alerts (neutral entry, no seed)
  - notice: #notice/20260716009 with Watch CTA href visible
  - after: pre-scoped #alerts?lens=meetings&filter=…&notice=20260716009
    with context lead + real digItemHTML email mock

    python3 tools/capture_alerts_context_carry.py
"""

from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import textwrap
from urllib.parse import quote

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "alerts-context-carry"
VIEWPORTS = ((390, 844), (1440, 900))
NOTICE_ID = "20260716009"
AFTER_HASH = (
    "#alerts?lens=meetings"
    f"&filter={quote('{\"agency\":\"Transportation\"}', safe='')}"
    f"&notice={NOTICE_ID}"
)


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


def shot(page, base: str, name: str, hash_path: str, wait_sel: str, caption: str, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base}index.html{hash_path}", wait_until="domcontentloaded")
    page.wait_for_selector(wait_sel, timeout=25_000)
    page.wait_for_timeout(600)
    raw = OUTPUT / f"{name}-{width}x{height}-raw.png"
    page.screenshot(path=str(raw), full_page=False)
    annotate(raw, OUTPUT / f"{name}-{width}x{height}.png", caption)
    raw.unlink(missing_ok=True)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base, sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                # Before: neutral alerts (no context).
                shot(
                    page, base, "before-neutral",
                    "#alerts",
                    "#tab-alerts",
                    "Before: bare #alerts — no notice scope, empty generic builder.",
                    width, height,
                )
                # Notice page with Watch CTA.
                shot(
                    page, base, "notice-cta",
                    f"#notice/{NOTICE_ID}",
                    "#nactions .next-action-rail, #noticeview .panel",
                    "Notice 20260716009 (Dining Out NYC). Watch CTA carries #alerts?lens=meetings&notice=…",
                    width, height,
                )
                # After: pre-scoped with seed preview.
                page.goto(f"{base}index.html{AFTER_HASH}", wait_until="domcontentloaded")
                page.wait_for_selector("#tab-alerts", timeout=15_000)
                try:
                    page.wait_for_selector("#acontextlead:not([hidden])", timeout=12_000)
                except Exception:
                    pass
                try:
                    page.wait_for_selector("#apreviewbox .emailmock, #apreviewbox .digitem", timeout=20_000)
                except Exception:
                    page.wait_for_timeout(1500)
                page.wait_for_timeout(400)
                raw = OUTPUT / f"after-scoped-{width}x{height}-raw.png"
                page.screenshot(path=str(raw), full_page=False)
                annotate(
                    raw,
                    OUTPUT / f"after-scoped-{width}x{height}.png",
                    "After: meetings + Transportation pre-scoped, context lead, digItemHTML email preview of this notice.",
                )
                raw.unlink(missing_ok=True)
                page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
