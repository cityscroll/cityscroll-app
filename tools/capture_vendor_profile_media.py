#!/usr/bin/env python3
"""Capture deterministic annotated vendor-profile before/after evidence.

Serves the current repository, stubs every external request in the browser, and captures
the same CAMBA fixture used by test/perf/vendor-profile-instant.test.mjs at 390x844 and
1440x900. The "before" frame recreates the prior resolving state in the real page shell;
the "after" frame exercises showVendor() and its precomputed worker-response path.

    python3 tools/capture_vendor_profile_media.py

Requires Playwright Chromium, matching the repository's functional-test setup:

    pip install playwright
    playwright install chromium
"""

from __future__ import annotations

import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "review" / "vendor-profile-instant"
VIEWPORTS = ((390, 844), (1440, 900))

CAMBA = {
    "stem": "CAMBA",
    "display": "Camba Inc.",
    "variants": [
        {"name": "CAMBA", "n": 3, "total": 11800080, "first": "2008-03-10", "last": "2011-05-02"},
        {"name": "Camba Inc.", "n": 135, "total": 1106326956.53, "first": "2010-10-05", "last": "2025-07-31"},
        {"name": "Camba, Inc", "n": 7, "total": 85947407.33, "first": "2016-01-28", "last": "2020-11-04"},
        {"name": "CAMBA Inc", "n": 9, "total": 147676229, "first": "2026-05-13", "last": "2026-07-27"},
        {"name": "CAMBA  Inc", "n": 17, "total": 141415368.94, "first": "2019-07-12", "last": "2022-12-07"},
        {"name": "CAMBA, Inc.", "n": 92, "total": 352563435.1, "first": "2007-09-14", "last": "2026-03-18"},
        {"name": "CAMBA, Inc.,", "n": 4, "total": 9496422, "first": "2012-06-13", "last": "2022-06-06"},
        {"name": "CAMBA. Inc.", "n": 2, "total": 61057155, "first": "2015-09-03", "last": "2021-07-21"},
        {"name": "CAMBA., Inc.", "n": 2, "total": 30033469, "first": "2010-05-12", "last": "2022-07-08"},
    ],
    "awardCount": 271,
    "total": 1946316522.9,
    "first": "2007-09-14",
    "last": "2026-07-27",
    "topAgencies": [],
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


def install_fixtures(page: Page) -> None:
    # Resource requests are hermetic; fetch() itself is replaced before index.html runs.
    page.route("https://**", lambda route: route.abort())
    fixture = json.dumps({"ok": True, "generated": "2026-07-27T13:00:00.000Z", "profile": CAMBA})
    page.add_init_script(
        f"""
        (() => {{
          const nativeFetch = window.fetch.bind(window);
          const profileBody = {json.dumps(fixture)};
          window.fetch = (input, init) => {{
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes("/vendor-profile?")) {{
              return new Promise(resolve => setTimeout(() => resolve(new Response(profileBody, {{
                status: 200, headers: {{"Content-Type": "application/json"}}
              }})), 40));
            }}
            if (url.includes("data.cityofnewyork.us") || url.includes("/inv/")) {{
              return new Promise(() => {{}});
            }}
            if (url.startsWith(location.origin)) return nativeFetch(input, init);
            return Promise.resolve(new Response("{{}}", {{
              status: 200, headers: {{"Content-Type": "application/json"}}
            }}));
          }};
          window.turnstile = {{getResponse: () => "", reset: () => {{}}}};
        }})();
        """
    )


def annotate(page: Page, after: bool) -> None:
    page.evaluate(
        """
        ({after}) => {
          document.querySelectorAll(".review-annotation").forEach(el => el.remove());
          const box = document.querySelector("#entityview");
          window.scrollTo(0, Math.max(0, box.offsetTop - 70));
          const boxRect = box.getBoundingClientRect();
          let left, top, width, height;
          if (after) {
            const first = box.querySelector(".ftype").getBoundingClientRect();
            const last = box.querySelector(".agencybar").getBoundingClientRect();
            left = first.left - 8;
            top = first.top - 8;
            width = first.width + 16;
            height = last.bottom - first.top + 16;
          } else {
            width = Math.min(880, boxRect.width);
            left = boxRect.left + (boxRect.width - width) / 2;
            top = boxRect.top - 8;
            height = 190;
          }
          top = Math.max(42, top);
          left = Math.max(4, left);
          width = Math.min(width, innerWidth - left - 4);

          const mark = document.createElement("div");
          mark.className = "review-annotation";
          Object.assign(mark.style, {
            position: "fixed", left: `${left}px`, top: `${top}px`,
            width: `${width}px`, height: `${height}px`,
            border: "4px solid #d60000", boxSizing: "border-box",
            zIndex: "99999", pointerEvents: "none"
          });

          const label = document.createElement("div");
          label.className = "review-annotation";
          label.textContent = after ? "↓ INSTANT IDENTITY HEADER" : "↓ CHANGED REGION";
          Object.assign(label.style, {
            position: "fixed", left: `${left + 4}px`, top: `${Math.max(4, top - 34)}px`,
            background: "#d60000", color: "white", padding: "6px 10px",
            font: "800 12px/1 system-ui", zIndex: "100000"
          });
          document.body.append(mark, label);
        }
        """,
        {"after": after},
    )


def capture(page: Page, base_url: str, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base_url}#vendor/Camba%20Inc.", wait_until="domcontentloaded")

    # Recreate the previous blocking state inside the real application shell.
    page.evaluate(
        """
        () => {
          showTab("entity");
          document.querySelector("#entityview").innerHTML =
            '<div class="empty"><span class="loading"></span> resolving vendor: Camba Inc.…</div>';
        }
        """
    )
    annotate(page, after=False)
    before = OUTPUT / f"before-{width}.png"
    page.screenshot(path=str(before))

    page.evaluate("() => { document.querySelectorAll('.review-annotation').forEach(el => el.remove()); void showVendor('Camba Inc.'); }")
    page.wait_for_function(
        """
        () => {
          const box = document.querySelector("#entityview");
          return box && box.textContent.includes("271") && box.textContent.includes("9 name variants");
        }
        """,
        timeout=1000,
    )
    annotate(page, after=True)
    after = OUTPUT / f"after-{width}.png"
    page.screenshot(path=str(after))

    assert before.stat().st_size > 10_000
    assert after.stat().st_size > 10_000
    print(f"captured {before.relative_to(ROOT)}")
    print(f"captured {after.relative_to(ROOT)}")


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
