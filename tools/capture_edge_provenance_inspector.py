#!/usr/bin/env python3
"""Headless captures for the graph edge provenance inspector (agency host).

Viewports: 390 and 1440. Writes under site/media/review/edge-provenance-inspector/.
Serves the static site directory so agency constellation documents resolve.
"""
from __future__ import annotations

import functools
import json
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "media" / "review" / "edge-provenance-inspector"
VIEWPORTS = ((390, 844), (1440, 900))
AGENCY = "parks-and-recreation"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def first_claim_id() -> str:
    html = (ROOT / "site" / "agencies" / AGENCY / "index.html").read_text(encoding="utf-8")
    match = re.search(r'data-edge-claim="([^"]+)"', html)
    if not match:
        raise SystemExit("No data-edge-claim found on Parks constellation document; rebuild first.")
    return match.group(1)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    claim_id = first_claim_id()
    path = f"/agencies/{AGENCY}/?claim={claim_id}"

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    receipt = {
        "agency": AGENCY,
        "claim_id": claim_id,
        "path": path,
        "viewports": [list(v) for v in VIEWPORTS],
        "frames": [],
    }

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()
                page.goto(base + path, wait_until="networkidle")
                page.wait_for_selector("[data-edge-provenance-panel]", timeout=10000)
                page.wait_for_selector(".edge-prov-inspector[data-open='true'], .edge-prov-inspector", timeout=10000)
                # Ensure the inspector is in view for the frame.
                page.evaluate(
                    """() => {
                      const el = document.querySelector('.edge-prov-inspector')
                        || document.querySelector('[data-edge-provenance-panel]');
                      el?.scrollIntoView({ block: 'start' });
                    }"""
                )
                page.wait_for_timeout(200)
                dest = OUT / f"parks-claim-inspector-{width}.png"
                page.screenshot(path=str(dest), full_page=True)
                receipt["frames"].append(str(dest.relative_to(ROOT)))
                print("wrote", dest.relative_to(ROOT))
                context.close()
            browser.close()
    finally:
        server.shutdown()

    (OUT / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("wrote", (OUT / "receipt.json").relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
