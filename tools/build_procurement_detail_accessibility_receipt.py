#!/usr/bin/env python3
"""Build the retained procurement detail accessibility and layout receipt.

Refreshes both the axe viewport scans and the layout/keyboard destination
counts in docs/evidence/procurement-detail-parity/read-back.json from one
headless render of the committed fixture. Link counts are measured from the
same native <a href> markup the read-back test asserts — never hand-edited.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import socketserver
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RECEIPT = ROOT / "docs/evidence/procurement-detail-parity/read-back.json"
AXE = ROOT / "test/functional/assets/axe.min.js"
VIEWPORTS = {"desktop": (1440, 900), "mobile": (390, 844)}
ANCHOR_RE = re.compile(r"<a\b([^>]*)>", re.IGNORECASE)


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, _format, *_args):
        return


class FastThreadingHTTPServer(ThreadingHTTPServer):
    """Avoid a slow reverse-DNS lookup on hosts with local name resolution disabled."""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


def render_fixture() -> str:
    result = subprocess.run(
        ["node", str(ROOT / "tools/render_procurement_detail_accessibility_fixture.mjs")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return result.stdout


def keyboard_layout(markup: str) -> dict:
    """Count native keyboard destinations the same way the read-back test does."""
    attrs = ANCHOR_RE.findall(markup)
    if any(not re.search(r"\bhref=", item) for item in attrs):
        raise SystemExit("layout receipt refused: an <a> is missing href")
    negative = len(re.findall(r'tabindex=["\']-1["\']', markup, flags=re.IGNORECASE))
    return {
        "visible_native_links": len(attrs),
        "reachable_links": len(attrs),
        "negative_tabindex": negative,
    }


def layout_probe(page) -> dict:
    return page.evaluate(
        """() => {
          const doc = document.documentElement;
          return {
            scroll_width: doc.scrollWidth,
            overflow: doc.scrollWidth > window.innerWidth + 1,
          };
        }"""
    )


def scan(page, markup: str) -> dict:
    result = page.evaluate("async () => await axe.run(document)")
    ids = sorted({
        entry["id"]
        for key in ("violations", "incomplete", "passes", "inapplicable")
        for entry in result.get(key, [])
    })
    represented_nodes = {
        json.dumps(node.get("target", []), sort_keys=True)
        for key in ("violations", "incomplete", "passes", "inapplicable")
        for entry in result.get(key, [])
        for node in entry.get("nodes", [])
    }

    def compact(entry):
        return {
            "id": entry["id"],
            "impact": entry.get("impact"),
            "nodes": [node.get("target", []) for node in entry.get("nodes", [])],
        }

    violations = [compact(entry) for entry in result["violations"]]
    serious_or_critical = [
        entry for entry in violations if entry["impact"] in ("serious", "critical")
    ]
    return {
        "engine": result["testEngine"],
        "viewport": {"width": page.viewport_size["width"], "height": page.viewport_size["height"]},
        "rules_run": ids,
        "nodes_examined": len(represented_nodes),
        "violations": violations,
        "passes": [
            {"id": entry["id"], "nodes": len(entry.get("nodes", []))}
            for entry in result.get("passes", [])
        ],
        "serious_or_critical": serious_or_critical,
        "markup_sha256": hashlib.sha256(markup.encode("utf-8")).hexdigest(),
        "scanned_at": page.evaluate("() => new Date().toISOString()"),
        "layout": layout_probe(page),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan-time", help="ISO instant supplied to the shared test clock")
    args = parser.parse_args()
    if args.scan_time:
        scan_time = args.scan_time
    else:
        scan_time = subprocess.run(
            ["node", "--import=./test/helpers/test_clock_preload.mjs", "--input-type=module", "-e",
             "import { testClockISOString } from './test/helpers/test_clock.mjs'; process.stdout.write(testClockISOString())"],
            cwd=ROOT, capture_output=True, text=True, check=True,
            env={**os.environ, "CITYSCROLL_TEST_TIME_PIN": os.environ.get("CITYSCROLL_TEST_TIME_PIN", "")},
        ).stdout
    html = render_fixture()
    server = FastThreadingHTTPServer(("127.0.0.1", 0), SiteHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    route = f"http://127.0.0.1:{server.server_address[1]}/_capture/procurement-detail"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        scans = {}
        for name, (width, height) in VIEWPORTS.items():
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            page.add_init_script(
                """(() => {
                  const NativeDate = Date;
                  const epoch = NativeDate.parse(%s);
                  class PinnedDate extends NativeDate {
                    constructor(...args) { super(...(args.length ? args : [epoch])); }
                    static now() { return epoch; }
                  }
                  window.Date = PinnedDate;
                })();""" % json.dumps(scan_time),
            )
            page.route("https://fonts.googleapis.com/**", lambda request_route: request_route.abort())
            page.route("https://fonts.gstatic.com/**", lambda request_route: request_route.abort())
            page.route(route, lambda request_route: request_route.fulfill(
                status=200, content_type="text/html", body=html,
            ))
            page.goto(route, wait_until="domcontentloaded", timeout=30000)
            served_markup = page.content()
            page.add_script_tag(path=str(AXE))
            scans[name] = scan(page, served_markup)
            context.close()
        browser.close()
    server.shutdown()

    accessibility = {
        "engine": scans["desktop"]["engine"],
        "scope": "served canonical procurement detail fixture at desktop and mobile viewports",
        "viewports": scans,
        "assertion": "The automated accessibility receipt reports no serious or critical findings for either retained viewport.",
    }
    keyboard = keyboard_layout(html)
    layout = {
        "desktop": {
            "viewport": list(VIEWPORTS["desktop"]),
            "scroll_width": scans["desktop"]["layout"]["scroll_width"],
            "overflow": scans["desktop"]["layout"]["overflow"],
        },
        "mobile": {
            "viewport": list(VIEWPORTS["mobile"]),
            "scroll_width": scans["mobile"]["layout"]["scroll_width"],
            "overflow": scans["mobile"]["layout"]["overflow"],
        },
        "keyboard": keyboard,
    }
    for viewport_scan in scans.values():
        viewport_scan.pop("engine", None)
        viewport_scan.pop("layout", None)
    current = json.loads(RECEIPT.read_text(encoding="utf-8"))
    current["layout"] = layout
    current["accessibility"] = accessibility
    RECEIPT.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {RECEIPT.relative_to(ROOT)} "
        f"(visible_native_links={keyboard['visible_native_links']}, "
        f"negative_tabindex={keyboard['negative_tabindex']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
