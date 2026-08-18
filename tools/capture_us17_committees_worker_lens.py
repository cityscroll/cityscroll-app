#!/usr/bin/env python3
"""Before/after coverage-panel captures for US-17 Committees worker lens."""

from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "us17-committees-worker-lens"
QUERY = "Committee on Finance"
VIEWPORTS = ((1440, 1100), (390, 844))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        return


def serve_site(directory: Path):
    server = ThreadingHTTPServer(("127.0.0.1", 0), None)

    class Bound(QuietHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

    server.RequestHandlerClass = Bound
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    return server, f"http://{host}:{port}"


def empty_candidates(query: str) -> dict:
    # Keep the page on the keyword/legacy path so the collection coverage panel paints.
    return {
        "schema": "cityscroll.semantic_retrieval.candidate_response.v1",
        "query": query,
        "method": "lexical_fallback_v1",
        "corpus": {
            "schema": "cityscroll.semantic_retrieval.corpus_manifest.v1",
            "manifest_version": 1,
            "manifest_sha256": "0" * 64,
            "content_sha256": "1" * 64,
            "observed_on": "2026-08-17",
        },
        "index": {
            "schema": "cityscroll.semantic_retrieval.source_passage_map.v1",
            "version": "0" * 64,
            "corpus_sha256": "1" * 64,
            "observed_on": "2026-08-17",
        },
        "candidates": [],
    }


def wait_coverage(page):
    page.wait_for_selector('[data-search-coverage][data-coverage-state]', timeout=30000)
    page.wait_for_function(
        """() => {
          const row = document.querySelector('[data-coverage-lens="committees"]');
          return Boolean(row && row.getAttribute('data-coverage-state'));
        }"""
    )
    details = page.locator("[data-search-coverage] details")
    if details.count():
        details.first.evaluate("el => { el.open = true; }")


def capture_coverage(page, output: Path) -> None:
    panel = page.locator("[data-search-coverage]")
    panel.wait_for(state="visible", timeout=30000)
    panel.scroll_into_view_if_needed()
    panel.screenshot(path=output, animations="disabled")


def capture_search(page, output: Path) -> None:
    page.screenshot(path=output, animations="disabled", full_page=False)


def install_routes(page, keyword_body: dict):
    candidates = empty_candidates(QUERY)

    def fulfill(route, request):
        url = request.url
        if "/search/candidates" in url:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(candidates))
            return
        if "/search?" in url or url.rstrip("/").endswith("/search"):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(keyword_body))
            return
        route.continue_()

    page.route("https://api.cityscroll.org/**", fulfill)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    before_body = json.loads((OUT / "before-full-search-body.json").read_text())
    after_body = json.loads((OUT / "after-full-search-body.json").read_text())

    server, base_url = serve_site(ROOT / "site")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for state, body, expected_state, expected_label_fragment in (
                ("before", before_body, "not_indexed", "not indexed"),
                ("after", after_body, "matched", "indexed"),
            ):
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    install_routes(page, body)
                    page.goto(
                        f"{base_url}/search/?q=Committee%20on%20Finance",
                        wait_until="domcontentloaded",
                        timeout=60000,
                    )
                    wait_coverage(page)
                    suffix = "1440" if width > 800 else "390"
                    capture_coverage(page, OUT / f"{state}-coverage-{suffix}.png")
                    if width > 800:
                        capture_search(page, OUT / f"{state}-search-{suffix}.png")
                    row_state = page.get_attribute(
                        '[data-coverage-lens="committees"]',
                        "data-coverage-state",
                    )
                    label = page.locator('[data-coverage-lens="committees"] strong').inner_text()
                    assert row_state == expected_state, (state, row_state)
                    assert expected_label_fragment in label.lower(), (state, label)
                    context.close()
            browser.close()
    finally:
        server.shutdown()

    (OUT / "README.md").write_text(
        """# US-17 Committees worker lens evidence

Query: `Committee on Finance`.

## Before (production)

Live `api.cityscroll.org/search` reports Committees as not indexed and returns no typed Committee objects.

- Coverage state: `not_indexed`
- `indexed_count`: null
- Typed Committee results: 0

![Before coverage panel](before-coverage-1440.png)

## After (this branch)

The worker indexes all 96 published Committee documents through the production collection provider seam.

- Coverage state: `matched` (`indexed` in the panel)
- `indexed_count`: 96
- Query returns `committee:11` → `/committees/11/`

![After coverage panel](after-coverage-1440.png)
""",
        encoding="utf-8",
    )
    print(f"wrote captures under {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
