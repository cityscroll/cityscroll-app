"""Rendered browser journey for scoped consultation search return state."""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test" / "browser"))
from browser_support import launched_chromium  # noqa: E402


SEARCH_RECORD = {
    "object_ref": "consultation:bloomingdale-library-and-housing",
    "object_type": "consultation",
    "entity_type": "consultation",
    "domain": "participation",
    "title": "Bloomingdale Library and Housing",
    "summary": "Share feedback on the library and housing proposal.",
    "source_route": "/consultations/bloomingdale-library-and-housing/",
    "canonical_href": "/consultations/bloomingdale-library-and-housing/",
    "source_observation_refs": ["consultation:browser-journey"],
    "provenance": {
        "kind_label": "Consultation",
        "lifecycle": {"state": "current"},
        "source_freshness": {"observed_at": "2026-09-15T00:00:00.000Z"},
    },
    "match_evidence": {
        "field": "title",
        "matched_normalized_term": "library",
        "source_identifier": "consultation:browser-journey",
        "snippet": {"text": "Bloomingdale Library and Housing", "mark_start": 13, "mark_end": 20},
    },
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        path = unquote(urlsplit(self.path).path)
        if path == "/search/candidates":
            self.send_response(503)
            self.end_headers()
            return
        if path == "/search":
            payload = {
                "schema": "cityscroll.keyword_search_response.v1",
                "match_mode": "keyword",
                "query": "library",
                "lanes": [{"id": "consultations", "status": "matched", "as_of": "2026-09-15T00:00:00.000Z"}],
                "results": [SEARCH_RECORD],
                "coverage": {"by_lens": {"consultations": {"state": "matched", "as_of": "2026-09-15T00:00:00.000Z"}}},
            }
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/search/") and path != "/search/":
            relative_asset = path[len("/search/"):]
            asset_path = ROOT / "site" / relative_asset
            if asset_path.is_file():
                body = asset_path.read_bytes()
                content_type = {
                    ".css": "text/css",
                    ".js": "text/javascript",
                    ".mjs": "text/javascript",
                    ".json": "application/json",
                }.get(asset_path.suffix, "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        root_asset = ROOT / path.lstrip("/") if path.startswith("/capabilities/") else ROOT / "site" / path.lstrip("/")
        if root_asset.is_file():
            body = root_asset.read_bytes()
            content_type = {
                ".css": "text/css",
                ".js": "text/javascript",
                ".mjs": "text/javascript",
                ".json": "application/json",
            }.get(root_asset.suffix, "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        relative = path.lstrip("/") or "index.html"
        if path == "/search/":
            relative = "search/index.html"
        file_path = ROOT / relative if relative.startswith("site/") else ROOT / "site" / relative
        if file_path.is_dir():
            file_path = file_path / "index.html"
        if not file_path.is_file():
            self.send_error(404)
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html" if file_path.suffix == ".html" else "text/javascript")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with launched_chromium() as browser:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.add_init_script(
                f"window.CROL_API_ORIGIN = {json.dumps(base)}; window.CROL_API_FALLBACK_ORIGIN = {json.dumps(base)};"
            )
            route = "/search/?q=library&source_scope=consultations"
            page.goto(base + route, wait_until="domcontentloaded", timeout=30_000)
            result = page.locator("[data-search-lane='consultations'] .topic-search-result-full-record").first
            result.wait_for(state="visible", timeout=30_000)
            page.locator("#search-query").wait_for(state="visible", timeout=30_000)
            page.locator("[data-search-scope-label]").wait_for(state="visible", timeout=30_000)
            page.evaluate("window.scrollTo(0, 300)")
            result.focus()
            before = page.evaluate("""() => ({
                route: `${location.pathname}${location.search}`,
                query: document.querySelector('#search-query').value,
                scope: document.querySelector('[data-search-scope-label]').textContent.trim(),
                scrollY: Math.round(window.scrollY),
                focus: document.activeElement?.getAttribute('href') || null,
            })""")
            assert before["route"] == route, before
            assert before["query"] == "library", before
            assert before["scope"] == "consultations", before
            assert before["scrollY"] > 0, before
            assert before["focus"] == SEARCH_RECORD["canonical_href"], before
            result.evaluate("node => node.click()")
            page.wait_for_url(lambda url: "/consultations/bloomingdale-library-and-housing/" in url, timeout=30_000)
            page.go_back(wait_until="domcontentloaded", timeout=30_000)
            page.locator("[data-search-lane='consultations'] .topic-search-result-full-record").first.wait_for(state="visible", timeout=30_000)
            page.wait_for_function(
                "href => document.activeElement?.getAttribute('href') === href",
                arg=SEARCH_RECORD["canonical_href"],
                timeout=30_000,
            )
            after = page.evaluate("""() => ({
                route: `${location.pathname}${location.search}`,
                query: document.querySelector('#search-query').value,
                scope: document.querySelector('[data-search-scope-label]').textContent.trim(),
                scrollY: Math.round(window.scrollY),
                focus: document.activeElement?.getAttribute('href') || null,
            })""")
            assert after == before, {"before": before, "after": after}
            page.close()
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
