#!/usr/bin/env python3
"""Capture the Property item-type promise before and after the parity fix."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "property-facet-count-parity"
FIXTURE = runpy.run_path(str(ROOT / "test" / "functional" / "25_property_facet_count_parity.py"))


def archive_site(revision: str, destination: Path) -> Path:
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision, "site"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as bundle:
        bundle.extractall(destination)
    return destination / "site"


@contextmanager
def serve(site: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(site), **kwargs)

        def log_message(self, *_args):
            return

        def do_GET(self):  # noqa: N802
            if urlsplit(self.path).path.rstrip("/") == "/browse/property":
                original = self.path
                self.path = "/index.html"
                try:
                    return super().do_GET()
                finally:
                    self.path = original
            return super().do_GET()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()


def capture(browser, site: Path, label: str, rows: list[dict], asset: str = "seized_property") -> dict:
    body = json.dumps(FIXTURE["payload"](rows))
    with serve(site) as base:
        page = browser.new_page(viewport={"width": 1440, "height": 1100}, device_scale_factor=1)
        page_errors: list[str] = list()
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        def route(request):
            url = request.request.url
            if "/property-locations" in url or "property:location" in url:
                request.fulfill(status=200, content_type="application/json", body=body)
                return
            if "dg92-zbpx" in url:
                request.fulfill(status=200, content_type="application/json", body=json.dumps(rows))
                return
            if url.endswith("/session"):
                request.fulfill(status=200, content_type="application/json", body='{"authenticated":false}')
                return
            if "/suggestions" in url:
                request.fulfill(status=200, content_type="application/json", body='{"suggestions":[]}')
                return
            if "cloudflareinsights.com/cdn-cgi/rum" in url:
                request.fulfill(status=204, body="")
                return
            request.continue_()

        page.route("**/*", route)
        page.goto(f"{base}/browse/property/?asset={asset}", wait_until="domcontentloaded")
        page.wait_for_function(
            "asset => document.querySelector(`#assettabs [data-a=${asset}].on`) && document.querySelector('#propertyfeed') && !document.querySelector('#propertyfeed .skl')",
            arg=asset,
            timeout=30_000,
        )
        page.locator("#tab-property").screenshot(path=str(OUT / f"{label}-{asset.replace('_', '-')}-1440.png"))
        result = page.evaluate(r"""() => ({
          chip: Number(document.querySelector('#assettabs .chip.on .ct')?.textContent),
          current: Number(document.querySelector('[data-property-view=default] .ct')?.textContent),
          archive: Number(document.querySelector('[data-property-view=archive] .ct')?.textContent),
          resultCount: Number((document.querySelector('#property-count')?.textContent || '').match(/\d+/)?.[0]),
          genericEmpty: document.querySelector('#propertyfeed')?.innerText?.includes('Nothing found') || false,
          scopeEmpty: Boolean(document.querySelector('[data-property-scope-empty]')),
          archiveAction: Boolean(document.querySelector('[data-property-empty-view=archive]')),
        })""")
        page.close()
        if page_errors:
            raise RuntimeError(f"{label} page errors: {page_errors}")
        return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before-ref", default="HEAD^")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = FIXTURE["fixture_rows"]()

    with tempfile.TemporaryDirectory(prefix="crol-property-facet-before-") as temp:
        before_site = archive_site(args.before_ref, Path(temp))
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            before = capture(browser, before_site, "before", rows)
            after = capture(browser, ROOT / "site", "after", rows)
            archive_only = capture(browser, ROOT / "site", "after-archive-only", rows, "scrap_materials")
            browser.close()

    receipt = {
        "fixture": {"seized_total": 17, "seized_current": 15, "seized_archive": 2},
        "before": before,
        "after": after,
        "after_archive_only": archive_only,
    }
    (OUT / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    assert before == {"chip": 17, "current": 0, "archive": 0, "resultCount": 0, "genericEmpty": True, "scopeEmpty": False, "archiveAction": False}, before
    assert after == {"chip": 15, "current": 15, "archive": 2, "resultCount": 15, "genericEmpty": False, "scopeEmpty": False, "archiveAction": False}, after
    assert archive_only == {"chip": 0, "current": 0, "archive": 1, "resultCount": 0, "genericEmpty": False, "scopeEmpty": True, "archiveAction": True}, archive_only
    print(f"wrote before/after screenshots and receipt under {OUT}")


if __name__ == "__main__":
    main()
