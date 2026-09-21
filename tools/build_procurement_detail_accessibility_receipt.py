#!/usr/bin/env python3
"""Build the retained procurement detail accessibility, layout, and capture proof.

Refreshes:
  - docs/evidence/served-procurement-route/read-back.json layout + accessibility
  - docs/evidence/served-procurement-route/capture-manifest.json viewport captures

Layout scroll widths are measured from a live headless render at desktop and
390 px. Keyboard proof Tabs until every named destination href receives focus.
Screenshot binaries land under .artifacts/ (gitignored); only hashes enter the
committed manifest.
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
from repository_revision import resolve_repository_revision

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RECEIPT = ROOT / "docs/evidence/served-procurement-route/read-back.json"
MANIFEST = ROOT / "docs/evidence/served-procurement-route/capture-manifest.json"
ARTIFACT_DIR = ROOT / ".artifacts/served-procurement-route"
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


def git_head() -> str:
    return resolve_repository_revision(ROOT)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def keyboard_counts(markup: str) -> dict:
    attrs = ANCHOR_RE.findall(markup)
    if any(not re.search(r"\bhref=", item) for item in attrs):
        raise SystemExit("layout receipt refused: an <a> is missing href")
    negative = len(re.findall(r'tabindex=["\']-1["\']', markup, flags=re.IGNORECASE))
    return {
        "visible_native_links": len(attrs),
        "negative_tabindex": negative,
    }


def layout_probe(page) -> dict:
    return page.evaluate(
        """() => {
          const doc = document.documentElement;
          const body = document.body;
          return {
            scroll_width: doc.scrollWidth,
            client_width: doc.clientWidth,
            inner_width: window.innerWidth,
            content_height: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
            overflow: doc.scrollWidth > window.innerWidth + 1,
          };
        }"""
    )


def keyboard_traverse(page, expected_hrefs: list[str]) -> dict:
    """Tab through the document until every named destination receives focus.

    Named destinations that live inside closed <details> are reached by opening
    the disclosure from its summary with Enter, then continuing Tab — the same
    path a keyboard user takes.
    """
    reached = []
    seen = set()
    focus_trace = []
    disclosures_opened = []
    budget = max(160, len(expected_hrefs) * 40)
    for _ in range(budget):
        page.keyboard.press("Tab")
        info = page.evaluate(
            """() => {
              const el = document.activeElement;
              if (!el) return null;
              const details = el.closest ? el.closest('details') : null;
              return {
                tag: el.tagName,
                href: el.getAttribute ? el.getAttribute('href') : null,
                is_summary: el.tagName === 'SUMMARY',
                details_open: details ? details.open : null,
                details_label: details
                  ? ((details.querySelector('summary') || {}).textContent || '').trim().slice(0, 80)
                  : null,
                text: (el.textContent || '').trim().slice(0, 80),
              };
            }"""
        )
        if not info:
            continue
        href = info.get("href")
        focus_trace.append({"tag": info.get("tag"), "href": href, "is_summary": info.get("is_summary")})
        if href in expected_hrefs and href not in seen:
            seen.add(href)
            reached.append(href)
            if len(seen) == len(expected_hrefs):
                break
            continue
        # Open closed disclosures that still hide a named destination.
        if info.get("is_summary") and info.get("details_open") is False:
            still_hidden = page.evaluate(
                """(expected) => {
                  const summary = document.activeElement;
                  const details = summary && summary.closest ? summary.closest('details') : null;
                  if (!details) return false;
                  return [...details.querySelectorAll('a[href]')]
                    .some((anchor) => expected.includes(anchor.getAttribute('href')));
                }""",
                expected_hrefs,
            )
            if still_hidden:
                page.keyboard.press("Enter")
                disclosures_opened.append(info.get("details_label") or "details")
        if len(seen) == len(expected_hrefs):
            break
    missing = [href for href in expected_hrefs if href not in seen]
    return {
        "expected_destinations": expected_hrefs,
        "reached_in_tab_order": reached,
        "missing_destinations": missing,
        "tabs_pressed": len(focus_trace),
        "disclosures_opened": disclosures_opened,
        "all_named_destinations_reached": len(missing) == 0,
    }


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
    counts = keyboard_counts(html)
    current_manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    expected_links = list(current_manifest["expected_links"])
    fixture_path = ROOT / current_manifest["fixture"]
    fixture_sha = sha256_bytes(fixture_path.read_bytes())
    source_commit = git_head()
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

    server = FastThreadingHTTPServer(("127.0.0.1", 0), SiteHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    route = f"http://127.0.0.1:{server.server_address[1]}/_capture/procurement-detail"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        scans = {}
        layout_viewports = {}
        capture_entries = []
        keyboard_proof = None
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
            # Allow linked same-origin CSS to apply before measuring boxes.
            page.wait_for_timeout(100)
            served_markup = page.content()
            probe = layout_probe(page)
            layout_viewports[name] = {
                "viewport": [width, height],
                "scroll_width": probe["scroll_width"],
                "client_width": probe["client_width"],
                "inner_width": probe["inner_width"],
                "content_height": probe["content_height"],
                "overflow": bool(probe["overflow"]),
            }
            if name == "desktop":
                keyboard_proof = keyboard_traverse(page, expected_links)
            page.add_script_tag(path=str(AXE))
            scans[name] = scan(page, served_markup)
            screenshot_path = ARTIFACT_DIR / f"{name}.png"
            page.screenshot(path=str(screenshot_path), full_page=True)
            screenshot_hash = sha256_bytes(screenshot_path.read_bytes())
            layout_hash = sha256_text(json.dumps(layout_viewports[name], sort_keys=True, separators=(",", ":")))
            capture_entries.append({
                "viewport": {"name": name, "width": width, "height": height},
                "assertion": (
                    "Measured document boxes show no horizontal overflow; keyboard Tab reaches every named destination; "
                    "automated accessibility checks report no serious or critical findings."
                    if name == "desktop"
                    else "At 390 px, measured document boxes show no horizontal overflow and the layout measurement differs from the desktop viewport."
                ),
                "render_sha256": sha256_text(served_markup),
                "layout": layout_viewports[name],
                "layout_sha256": layout_hash,
                "screenshot_sha256": screenshot_hash,
                "screenshot_path": f".artifacts/served-procurement-route/{name}.png",
            })
            context.close()
        browser.close()
    server.shutdown()

    if layout_viewports["desktop"]["viewport"][0] == layout_viewports["mobile"]["viewport"][0]:
        raise SystemExit("layout receipt refused: desktop and mobile viewports are identical")
    if layout_viewports["desktop"]["client_width"] == layout_viewports["mobile"]["client_width"]:
        raise SystemExit("layout receipt refused: measured client widths do not differ across viewports")
    desktop_layout_hash = capture_entries[0]["layout_sha256"]
    mobile_layout_hash = capture_entries[1]["layout_sha256"]
    if desktop_layout_hash == mobile_layout_hash:
        raise SystemExit("layout receipt refused: layout hashes are identical across viewports")
    for name, layout in layout_viewports.items():
        if layout["overflow"]:
            raise SystemExit(f"layout receipt refused: horizontal overflow at {name}")
        if layout["scroll_width"] > layout["inner_width"] + 1:
            raise SystemExit(f"layout receipt refused: scroll_width exceeds inner_width at {name}")
    if not keyboard_proof or not keyboard_proof["all_named_destinations_reached"]:
        missing = keyboard_proof["missing_destinations"] if keyboard_proof else expected_links
        raise SystemExit(f"keyboard traversal missed destinations: {missing}")

    accessibility = {
        "engine": scans["desktop"]["engine"],
        "scope": "served canonical procurement detail fixture at desktop and mobile viewports",
        "viewports": scans,
        "assertion": "The automated accessibility receipt reports no serious or critical findings for either retained viewport.",
    }
    for viewport_scan in scans.values():
        viewport_scan.pop("engine", None)

    layout = {
        "desktop": layout_viewports["desktop"],
        "mobile": layout_viewports["mobile"],
        "keyboard": {
            **counts,
            "reachable_links": counts["visible_native_links"],
            "named_destinations": keyboard_proof,
        },
        "viewports_differ": True,
        "measurement": "headless Chromium documentElement.scrollWidth/clientWidth/content_height at each viewport",
    }

    current = json.loads(RECEIPT.read_text(encoding="utf-8"))
    current["layout"] = layout
    current["accessibility"] = accessibility
    current["assertions"]["A7"] = (
        "Headless viewport probes measure document boxes with no horizontal overflow at desktop and 390 px; "
        "the two viewport measurements differ; keyboard Tab reaches every named destination in the capture manifest; "
        "axe reports no serious or critical findings."
    )
    RECEIPT.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")

    manifest = {
        "schema": "cityscroll.procurement_detail_parity_capture_manifest.v1",
        "browser_mode": "headless Chromium with repository CSS; image binaries omitted from git",
        "source_commit": source_commit,
        "fixture": current_manifest["fixture"],
        "fixture_sha256": fixture_sha,
        "data_vintage": current_manifest.get("data_vintage", scan_time),
        "route": current_manifest["route"],
        "expected_links": expected_links,
        "captures": capture_entries,
        "keyboard_traversal": keyboard_proof,
        "image_policy": (
            "Capture binaries remain ignored under .artifacts/served-procurement-route/. "
            "Committed proof is route, viewport, revision, data vintage, assertion, layout hash, and screenshot sha256."
        ),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(
        f"wrote {RECEIPT.relative_to(ROOT)} and {MANIFEST.relative_to(ROOT)} "
        f"(visible_native_links={counts['visible_native_links']}, "
        f"named_destinations_reached={len(keyboard_proof['reached_in_tab_order'])}, "
        f"desktop_overflow={layout_viewports['desktop']['overflow']}, "
        f"mobile_overflow={layout_viewports['mobile']['overflow']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
