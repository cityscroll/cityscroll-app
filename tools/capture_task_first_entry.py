#!/usr/bin/env python3
"""Capture the task-first entry experiment at review widths (390 and 1440).

Serves the repository root statically, fulfills the precomputed JSON from disk,
and writes real-content screenshots under docs/screenshots/task-first-entry/.
"""

from __future__ import annotations

import functools
import json
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "task-first-entry"
VIEWPORTS = ((390, 844), (1440, 900))
BUNDLE = json.loads((ROOT / "data" / "task_first_examples.json").read_text())


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


def install_routes(page: Page) -> None:
    def empty_json(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json", body="[]")

    def task_bundle(route: Route) -> None:
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(BUNDLE),
        )

    page.route("**/data/task_first_examples.json", task_bundle)
    page.route("https://data.cityofnewyork.us/**", empty_json)
    page.route("https://data.ny.gov/**", empty_json)
    page.route("https://api.cityscroll.org/**", empty_json)
    page.route("https://geosearch.planninglabs.nyc/**", empty_json)
    page.route("https://**", lambda route: route.abort())


def capture(page: Page, base_url: str, path: str, width: int, height: int, out_name: str) -> Path:
    page.set_viewport_size({"width": width, "height": height})
    # Hash-only navigations on the same document can skip load; land on a clean URL
    # then set the hash so applyHash always re-runs for this path.
    page.goto(base_url.rstrip("/") + "/index.html", wait_until="domcontentloaded")
    page.evaluate("(hash) => { location.hash = hash; }", path if path.startswith("#") else f"#{path}")
    page.wait_for_function(
        """() => {
          const active = document.querySelector('.tabpane.active');
          return active && active.id === 'tab-task' && document.querySelectorAll('.task-card').length >= 1;
        }""",
        timeout=15000,
    )
    page.locator(".task-first").wait_for(state="visible", timeout=15000)
    page.evaluate("document.fonts && document.fonts.ready")
    page.locator(".task-first").evaluate("el => el.scrollIntoView({ block: 'start' })")
    page.wait_for_timeout(250)
    cards = page.locator(".task-card").count()
    assert cards >= 1, f"expected task cards on {path}, found {cards}"
    # Collection hashes are #task/<slug> (one slash); item hashes add /<id>.
    if path.startswith("#task/") and path.count("/") == 1:
        assert cards == 5, f"collection {path} should list 5 cards, got {cards}"
    # Prefer the task panel region so mobile shots are not just the masthead.
    out = OUTPUT / out_name
    page.locator(".task-first").screenshot(path=str(out))
    return out


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        install_routes(page)
        written: list[Path] = []
        for width, height in VIEWPORTS:
            for slug, hash_path in (
                ("can-i-bid", "#task/can-i-bid"),
                ("what-will-change", "#task/what-will-change"),
            ):
                written.append(
                    capture(
                        page,
                        base_url,
                        hash_path,
                        width,
                        height,
                        f"{slug}-{width}.png",
                    )
                )
            # One focused item card per task at each width.
            written.append(
                capture(
                    page,
                    base_url,
                    "#task/can-i-bid/20260624023",
                    width,
                    height,
                    f"can-i-bid-item-{width}.png",
                )
            )
            written.append(
                capture(
                    page,
                    base_url,
                    "#task/what-will-change/2026X0362",
                    width,
                    height,
                    f"what-will-change-item-{width}.png",
                )
            )
        browser.close()
    for path in written:
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
