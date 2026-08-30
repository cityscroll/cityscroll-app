#!/usr/bin/env python3
"""Before/after capture: Following saved-watch management recovery.

Frames (each at 390 and 1440):
  recognized  manage-watches deep link with the Transportation/Queens watch
  error       personal-island failure on the same destination

Env:
  CROL_REGROUND_LABEL   "before" | "after"  (default "after")
  CROL_REGROUND_OUT     output dir (default docs/screenshots/following-management-recovery)
  CROL_REGROUND_ROOT    site root (default this checkout's site/)
"""

from __future__ import annotations

import functools
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Page, Route, sync_playwright

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None
    ImageDraw = None
    ImageFont = None

ROOT = Path(__file__).resolve().parents[1]
LABEL = os.environ.get("CROL_REGROUND_LABEL", "after")
OUT = Path(
    os.environ.get(
        "CROL_REGROUND_OUT",
        str(ROOT / "docs" / "screenshots" / "following-management-recovery"),
    )
)
SITE = Path(os.environ.get("CROL_REGROUND_ROOT", str(ROOT / "site")))
VIEWPORTS = ((390, 844), (1440, 900))

WATCH_HTML = """
<div data-session-recognized="true" data-personal-state="recognized">
  <article class="following-watch" data-watch-key="sub:meetings-queens" data-watch-lens="meetings"
    data-watch-filter="{&quot;agency&quot;:&quot;Transportation&quot;,&quot;borough&quot;:&quot;Queens&quot;}">
    <div class="following-watch-heading">
      <h3>Notify me when new hearings and meetings from Transportation are published in Queens</h3>
      <p class="watch-meta">Active · Weekly digest</p>
    </div>
    <div class="following-watch-controls">
      <form method="post" action="https://cityscroll.org/prefs" data-watch-action>
        <label>Cadence<select name="freq"><option selected>Weekly</option></select></label>
        <button type="submit">Save cadence</button>
      </form>
      <form method="post" action="https://cityscroll.org/prefs" data-watch-action>
        <button type="submit">Pause</button>
      </form>
      <form method="post" action="https://cityscroll.org/prefs" data-watch-action>
        <button type="submit">Unsubscribe</button>
      </form>
    </div>
  </article>
</div>
"""


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
    if Image is None:
        destination.write_bytes(source.read_bytes())
        return
    image = Image.open(source).convert("RGB")
    font = ImageFont.load_default(size=15)
    pad = 14
    bar_height = 46
    canvas = Image.new("RGB", (image.width, image.height + bar_height), "#1a1714")
    canvas.paste(image, (0, bar_height))
    draw = ImageDraw.Draw(canvas)
    draw.text((pad, 14), caption, fill="#f4efe4", font=font)
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, optimize=True)


def install_routes(page: Page, specimen: str) -> None:
    def api(route: Route) -> None:
        path = urlsplit(route.request.url).path
        if path == "/session":
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ok": True, "recognized": specimen == "recognized"}),
            )
            return
        if path == "/following/personal":
            if specimen == "error":
                route.abort()
                return
            route.fulfill(status=200, content_type="text/html", body=WATCH_HTML)
            return
        route.fulfill(status=404, content_type="application/json", body="{}")

    page.route("https://api.cityscroll.org/**", api)
    page.route("https://cityscroll-worker.crol-worker.workers.dev/**", api)
    page.route("https://data.cityofnewyork.us/**", lambda route: route.abort())


def assert_no_overflow(page: Page, name: str, width: int) -> None:
    overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
    if overflow > 1:
        raise SystemExit(f"{name} at {width}px overflowed by {overflow}px")


def wait_for_specimen(page: Page, specimen: str) -> None:
    if specimen == "recognized":
        page.locator("[data-watch-key='sub:meetings-queens']").wait_for(state="visible", timeout=15_000)
        return
    if LABEL == "after":
        page.get_by_text("Could not load saved watches.").wait_for(state="visible", timeout=15_000)
        return
    page.get_by_text("Open a CityScroll email to see your watches.").wait_for(state="visible", timeout=15_000)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with StaticServer(SITE) as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for specimen in ("recognized", "error"):
            page = browser.new_page()
            install_routes(page, specimen)
            for width, height in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                page.goto(f"{base}following/#your-following", wait_until="domcontentloaded", timeout=30_000)
                wait_for_specimen(page, specimen)
                assert_no_overflow(page, specimen, width)
                raw = OUT / f"{LABEL}-{specimen}-{width}-raw.png"
                dest = OUT / f"{LABEL}-{specimen}-{width}.png"
                page.screenshot(path=str(raw), full_page=True)
                annotate(
                    raw,
                    dest,
                    f"{LABEL}: {specimen} management recovery at {width}px",
                )
                raw.unlink(missing_ok=True)
            page.close()
        browser.close()
    receipt = {
        "label": LABEL,
        "route": "/following/#your-following",
        "viewports": [width for width, _height in VIEWPORTS],
        "specimens": ["recognized", "error"],
    }
    (OUT / f"{LABEL}-capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {LABEL} frames under {OUT}")


if __name__ == "__main__":
    main()
