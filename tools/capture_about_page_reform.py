#!/usr/bin/env python3
"""Capture the About-page reform at 390px and 1440px review widths.

The current checkout is the after state. The before state is read from git, so
the command remains reproducible after the change is committed:

    python3 tools/capture_about_page_reform.py --before <revision>
"""

from __future__ import annotations

import argparse
import functools
import io
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "site" / "media" / "review" / "about-page-reform"
VIEWPORTS = ((390, 844), (1440, 900))


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


def settle(page: Page) -> None:
    page.evaluate("document.fonts && document.fonts.ready")
    page.wait_for_timeout(200)


def scroll_to(page: Page, selector: str) -> None:
    page.locator(selector).wait_for(state="visible")
    page.evaluate(
        """selector => {
          const el = document.querySelector(selector);
          window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 72));
        }""",
        selector,
    )
    page.wait_for_timeout(100)


def capture_topic(page: Page, base_url: str, state: str, topic: str, width: int) -> dict:
    if topic == "overview":
        page.goto(f"{base_url}about.html", wait_until="load")
        page.evaluate("window.scrollTo(0, 0)")
    elif topic == "patterns":
        page.goto(f"{base_url}about.html#staffing-list-establishment-formula", wait_until="load")
        scroll_to(page, "#staffing-list-establishment-formula" if state == "before" else "#past-patterns")
    elif topic == "policy":
        selector = "#privacy" if state == "before" else "#accessibility"
        page.goto(f"{base_url}about.html{selector}", wait_until="load")
        scroll_to(page, selector)
    elif topic == "standards":
        if state == "before":
            page.goto(f"{base_url}standards.html", wait_until="load")
            page.wait_for_function("document.querySelectorAll('#langJoinBody tr').length === 10")
            scroll_to(page, "#selfConformance")
        else:
            page.goto(f"{base_url}about.html#accessibility", wait_until="load")
            scroll_to(page, "#accessibility")
    else:
        raise AssertionError(f"unknown topic: {topic}")

    settle(page)
    overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
    if overflow > 1:
        raise AssertionError(f"{state} {topic} {width}px overflows by {overflow}px")
    target = OUTPUT / f"{state}-{topic}-{width}.png"
    page.screenshot(path=target, animations="disabled")
    return {"file": str(target.relative_to(ROOT)), "overflow_px": overflow}


def capture_tree(browser, tree: Path, state: str, width: int, height: int) -> list[dict]:
    rows: list[dict] = list()
    with StaticServer(tree / "site") as base_url:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.route("https://**", lambda route: route.abort())
        errors: list[str] = list()
        page.on("pageerror", lambda error: errors.append(str(error)))
        for topic in ("overview", "patterns", "policy", "standards"):
            rows.append(capture_topic(page, base_url, state, topic, width))
        if errors:
            raise AssertionError(f"{state} {width}px page errors: {errors}")
        context.close()
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="HEAD", help="revision before the change")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    measurements = {"before_revision": args.before, "viewports": {}, "captures": []}

    with tempfile.TemporaryDirectory(prefix="crol-about-reform-") as temp:
        before_tree = Path(temp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in VIEWPORTS:
                    measurements["viewports"][str(width)] = dict(width=width, height=height)
                    measurements["captures"].extend(capture_tree(browser, before_tree, "before", width, height))
                    measurements["captures"].extend(capture_tree(browser, ROOT, "after", width, height))
            finally:
                browser.close()

    (OUTPUT / "measurements.json").write_text(json.dumps(measurements, indent=2) + "\n")
    print(json.dumps(measurements, indent=2))


if __name__ == "__main__":
    main()
