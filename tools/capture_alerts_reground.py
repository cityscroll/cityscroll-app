#!/usr/bin/env python3
"""Before/after capture: #alerts single-subscribe re-ground.

Frames (each at 390 and 1440):
  bare     bare #alerts entry (calm single flow vs dual forms)
  agency   #alerts?lens=entity&filter={kind:agency,name:…} (context in URL)

Env:
  CROL_REGROUND_LABEL   "before" | "after"  (default "after")
  CROL_REGROUND_OUT     output dir (default docs/screenshots/alerts-page-reground)
  CROL_REGROUND_ROOT    site root to serve (default this worktree's site/)

    python3 tools/capture_alerts_reground.py
    CROL_REGROUND_LABEL=before CROL_REGROUND_ROOT=/tmp/…/site python3 tools/capture_alerts_reground.py
"""

from __future__ import annotations

import functools
import os
import textwrap
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LABEL = os.environ.get("CROL_REGROUND_LABEL", "after")
OUT = Path(
    os.environ.get(
        "CROL_REGROUND_OUT",
        str(ROOT / "docs" / "screenshots" / "alerts-page-reground"),
    )
)
SITE = Path(os.environ.get("CROL_REGROUND_ROOT", str(ROOT / "site")))
VIEWPORTS = ((390, 844), (1440, 900))
AGENCY = "Design and Construction"
AGENCY_HASH = (
    "#alerts?lens=entity"
    f"&filter={quote(chr(123)+chr(34)+'kind'+chr(34)+':'+chr(34)+'agency'+chr(34)+','+chr(34)+'name'+chr(34)+':'+chr(34)+AGENCY+chr(34)+chr(125), safe='')}"
)
# Readable form for the hash (constructed above to avoid nested quote headaches).
AGENCY_HASH = (
    "#alerts?lens=entity&filter="
    + quote('{"kind":"agency","name":"Design and Construction"}', safe="")
)


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


def shot(
    page,
    base: str,
    name: str,
    hash_path: str,
    wait_sel: str,
    caption: str,
    width: int,
    height: int,
) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base}index.html{hash_path}", wait_until="domcontentloaded")
    page.wait_for_selector(wait_sel, timeout=25_000)
    page.wait_for_timeout(700)
    raw = OUT / f"{LABEL}-{name}-{width}-raw.png"
    page.screenshot(path=str(raw), full_page=False)
    annotate(raw, OUT / f"{LABEL}-{name}-{width}.png", caption)
    raw.unlink(missing_ok=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if not (SITE / "index.html").is_file():
        raise SystemExit(f"site root missing index.html: {SITE}")
    with StaticServer(SITE) as base, sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        for width, height in VIEWPORTS:
            shot(
                page,
                base,
                "bare",
                "#alerts",
                "#quizpanel",
                f"{LABEL}: bare #alerts — single subscribe flow",
                width,
                height,
            )
            shot(
                page,
                base,
                "agency",
                AGENCY_HASH,
                "#adest",
                f"{LABEL}: agency follow scope in hash + prefilled form",
                width,
                height,
            )
            # After only: email step should be the obvious finish field.
            if LABEL == "after":
                page.set_viewport_size({"width": width, "height": height})
                page.goto(f"{base}index.html{AGENCY_HASH}", wait_until="domcontentloaded")
                page.wait_for_selector("#apreviewbox .emailmock, #apreviewbox .empty", timeout=25_000)
                page.wait_for_timeout(900)
                # Scroll email into view for mobile evidence.
                page.evaluate("document.getElementById('adest')?.scrollIntoView({block:'center'})")
                page.wait_for_timeout(200)
                raw = OUT / f"{LABEL}-email-step-{width}-raw.png"
                page.screenshot(path=str(raw), full_page=False)
                annotate(
                    raw,
                    OUT / f"{LABEL}-email-step-{width}.png",
                    f"{LABEL}: one email step (finish the job)",
                )
                raw.unlink(missing_ok=True)
        browser.close()
    print(f"wrote {LABEL} frames under {OUT}")


if __name__ == "__main__":
    main()
