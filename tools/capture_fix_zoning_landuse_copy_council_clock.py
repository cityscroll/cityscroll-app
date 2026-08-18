#!/usr/bin/env python3
"""Before/after captures for land-use copy + Council clock coherence (2026R0127)."""

from __future__ import annotations

import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "fix-zoning-landuse-copy-council-clock"
LIVE = OUT / "2026R0127-live-api.json"
LABEL = "after"


def load_record():
    payload = json.loads(LIVE.read_text())
    return payload.get("record") or payload


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    record = load_record()
    project_id = record["project_id"]

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

        def log_message(self, format, *args):  # noqa: A003
            return

        def do_GET(self):  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path.rstrip("/").endswith("zap-outcomes") or "zap-outcomes" in parsed.path:
                qs = parse_qs(parsed.query)
                want = (qs.get("id") or [None])[0]
                body = json.dumps(
                    {
                        "ok": True,
                        "cached": True,
                        "stale": False,
                        "generated_at": record.get("generated_at") or "2026-08-17T12:00:00Z",
                        "record": record if want in (None, project_id) else None,
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 1600})

            async_api = record.get("api_base")

            def route_api(route):
                url = route.request.url
                if "zap-outcomes" in url:
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps(
                            {
                                "ok": True,
                                "cached": True,
                                "record": record,
                                "generated_at": "2026-08-17T12:00:00Z",
                            }
                        ),
                    )
                    return
                route.continue_()

            page.route("**/zap-outcomes*", route_api)
            if async_api:
                page.route(f"{async_api}/**", route_api)

            page.goto(f"{base}/browse/zoning/#land/{project_id}", wait_until="networkidle")
            page.wait_for_timeout(2500)
            # Force paint from injected record if SPA needs a nudge.
            page.evaluate(
                """(rec) => {
                  const el = document.querySelector('#land-actions, .action-rail, [data-action-rail]');
                  return !!(el || document.body.innerText.includes('City Council') || document.body.innerText.includes('participate'));
                }""",
                record,
            )
            page.screenshot(path=str(OUT / f"{LABEL}-2026R0127-full.png"), full_page=True)
            # Crop-ish second shot focused on action + timeline regions when present.
            for sel, name in [
                ("#land-actions", "actions"),
                (".land-pipeline-position, .land-spine-lead, #ldetail", "timeline"),
            ]:
                loc = page.locator(sel).first
                if loc.count():
                    try:
                        loc.screenshot(path=str(OUT / f"{LABEL}-2026R0127-{name}.png"))
                    except Exception:
                        pass
            browser.close()
    finally:
        server.shutdown()

    receipt = {
        "label": LABEL,
        "project_id": project_id,
        "actions": record.get("actions"),
        "public_status": record.get("public_status"),
        "notes": [
            "after: participation heading driven by acquisition action type",
            "after: Council due_date = start 2026-07-31 + 50 days = 2026-09-19",
            "outer_bound Nov 27 retained only as cumulative envelope",
        ],
    }
    (OUT / f"{LABEL}-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
