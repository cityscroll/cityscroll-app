#!/usr/bin/env python3
"""Headless before/after captures for static node documents (parcel + exam).

Viewports: 390 and 1440. Writes under site/media/review/node-page-design-consistency/.
After frames outline the shared hero, actions, and section-card regions.
"""
from __future__ import annotations

import argparse
import functools
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT_ROOT = ROOT / "site" / "media" / "review" / "node-page-design-consistency"
VIEWPORTS = ((390, 844), (1440, 900))
PAGES = (
    ("parcel-3017910019", "/parcels/3017910019/"),
    ("exam-7016", "/exams/7016/"),
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def annotate(page) -> None:
    page.evaluate(
        """() => {
        const mark = (sel, color, label) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.style.outline = `3px solid ${color}`;
          el.style.outlineOffset = '2px';
          const tag = document.createElement('div');
          tag.textContent = label;
          tag.style.cssText = `position:absolute;z-index:9999;background:${color};color:#fff;font:700 11px/1.2 system-ui;padding:4px 6px;border-radius:4px;`;
          const r = el.getBoundingClientRect();
          tag.style.left = (window.scrollX + r.left) + 'px';
          tag.style.top = Math.max(0, window.scrollY + r.top - 22) + 'px';
          document.body.appendChild(tag);
        };
        mark('.node-hero, .exam-hero, .civic-object-hero', '#1a44e0', 'hero');
        mark('.node-actions, .exam-actions, .civic-object-actions', '#1a6b34', 'actions');
        mark('.node-section.node-card, .civic-object-section[data-parcel-biography-domain], .exam-section', '#8a5a00', 'section card');
      }"""
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", choices=("before", "after"), default="after")
    parser.add_argument("--annotate", action="store_true", help="Outline changed regions (after frames)")
    args = parser.parse_args()
    out = OUT_ROOT / args.label
    out.mkdir(parents=True, exist_ok=True)

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for name, path in PAGES:
                for width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    page.goto(base + path, wait_until="networkidle")
                    page.wait_for_timeout(300)
                    if args.annotate or args.label == "after":
                        annotate(page)
                    dest = out / f"{name}-{width}.png"
                    page.screenshot(path=str(dest), full_page=True)
                    print("wrote", dest.relative_to(ROOT))
                    context.close()
            browser.close()
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
