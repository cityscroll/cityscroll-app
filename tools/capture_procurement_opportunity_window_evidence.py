#!/usr/bin/env python3
"""Headless evidence capture for procurement-pursuit-decision Card 2.

Captures the real renderProcurementDocument() output for the Card 2
opportunity-window derivation (site/procurement_opportunity_window.mjs):
an exact PASSPort release_date -> due_date response window (Fixture A),
Fixture A's City Record-only notice-to-due-window variant, a solicitation
whose window is unavailable, and the same window paired with the §6-129 and
accelerated-procurement rule floors from solicitation_procurement_method.mjs.

Follows the same pattern as tools/capture_procurement_pursuit_decision_baseline.py
and tools/capture_opportunity_calendar_evidence.py: render real production
HTML for a fixed set of named cases (via
tools/render_procurement_opportunity_window_capture_fixtures.mjs) and record a
screenshot plus a manifest entry per case, at the project's standard
390x844 / 1440x900 viewports.

Screenshot binaries are NOT committed to this repository. They are written to
an external directory (default: a `docs-evidence/` sibling of the repository
root; override with CAPTURE_EXTERNAL_OUT) and only a manifest — route,
viewport, revision, fixture/data vintage, the assertion each capture
demonstrates, and a sha256 content hash — is committed under
docs/evidence/procurement-pursuit-decision/windows/capture-manifest.json.

Nothing here changes production code; this is evidence tooling only.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_DIR = ROOT / "docs" / "evidence" / "procurement-pursuit-decision" / "windows"
EXTERNAL_OUT = Path(
    os.environ.get("CAPTURE_EXTERNAL_OUT")
    or (ROOT.parent / "docs-evidence" / "procurement-pursuit-decision" / "windows")
)
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]

DATA_VINTAGE_FIXTURE_A = (
    "passport_public_rfx observation ingested_at 2026-07-01T10:00:00Z; "
    "city_record observation ingested_at 2026-07-02T10:00:00Z; rendered as of 2026-07-10"
)

CASES = [
    (
        "procurement-detail-response-window",
        ["A"],
        DATA_VINTAGE_FIXTURE_A,
        "Fixture A's exact PASSPort release_date (2026-07-01) -> due_date (2026-08-05) renders as a "
        "response_window of exactly 35 calendar days, per test/procurement_opportunity_window.test.mjs.",
    ),
    (
        "procurement-detail-notice-to-due-window",
        ["A"],
        "city_record observation start_date 2026-07-02, due_date 2026-08-05; no exact PASSPort release "
        "observation; rendered as of 2026-07-10",
        "Fixture A's City Record-only variant renders as a notice_to_due_window of exactly 34 calendar "
        "days and is never labeled Response window.",
    ),
    (
        "procurement-detail-window-unavailable",
        ["A"],
        "passport_public_rfx observation with release_date but no due_date; rendered as of 2026-07-10",
        "A solicitation with an incomplete PASSPort boundary renders an explicit Window unavailable "
        "line rather than a 0-day window or silently vanishing.",
    ),
    (
        "procurement-detail-window-6129-floor",
        ["A"],
        DATA_VINTAGE_FIXTURE_A + "; city_record notice body cites Admin. Code Section 6-129",
        "The published 35-calendar-day response window is paired with the derived 27-calendar-day "
        "§6-129 rule floor as a side-by-side fact, with no compliance verdict language.",
    ),
    (
        "procurement-detail-window-accelerated-floor",
        ["A"],
        "passport_public_rfx release_date 2026-07-01, due_date 2026-07-06; city_record notice body "
        "cites the Accelerated Procurement Method, PPB Rules Section 3-07; rendered as of 2026-07-10",
        "A short published response window is paired with the derived 3-business-day accelerated "
        "procurement rule floor, with no compliance verdict language.",
    ),
]


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def render_fixtures() -> dict:
    result = subprocess.run(
        ["node", str(ROOT / "tools" / "render_procurement_opportunity_window_capture_fixtures.mjs")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def fulfill_html(html: str):
    def handler(route):
        route.fulfill(status=200, content_type="text/html", body=html)
    return handler


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
        "passes": len(gate) == 0,
    }


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def main() -> int:
    EXTERNAL_OUT.mkdir(parents=True, exist_ok=True)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    fixtures = render_fixtures()

    server = ThreadingHTTPServer(("127.0.0.1", 0), SiteHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"

    entries = []
    with sync_playwright() as p:
        browser = p.chromium.launch()

        for label, fixture_ids, data_vintage, assertion in CASES:
            html = fixtures[label]
            route_path = f"/_capture/{label}"
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
                page = context.new_page()
                page.route("https://fonts.googleapis.com/**", lambda r: r.abort())
                page.route("https://fonts.gstatic.com/**", lambda r: r.abort())
                page.route(f"{base}{route_path}", fulfill_html(html))
                page.goto(f"{base}{route_path}", wait_until="networkidle", timeout=20000)
                filename = f"{label}-{width}x{height}.png"
                shot = EXTERNAL_OUT / filename
                page.screenshot(path=str(shot), full_page=True)
                axe_result = run_axe(page)
                entries.append({
                    "case": label,
                    "surface": "procurement-detail",
                    "route": route_path,
                    "viewport": {"width": width, "height": height},
                    "revision": revision,
                    "fixture_ids": fixture_ids,
                    "data_vintage": data_vintage,
                    "assertion": assertion,
                    "external_filename": filename,
                    "sha256": sha256_of(shot),
                    "bytes": shot.stat().st_size,
                    "axe": axe_result,
                })
                page.close()
                context.close()

        browser.close()

    server.shutdown()

    manifest = {
        "schema": "cityscroll.procurement_pursuit_decision_windows_manifest.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "note": (
            "Card 2 (procurement-pursuit-decision): the provenance-safe opportunity window. "
            "Screenshot binaries are not committed to this repository; they are written to an "
            "external directory (default a docs-evidence/ sibling of the repository root, override "
            "with CAPTURE_EXTERNAL_OUT) named by 'external_filename' below, and this manifest is the "
            "reproducible, reviewable record of what each capture shows and why."
        ),
        "external_output_directory_note": "Not committed; see external_filename per capture. Re-run this script to regenerate byte-identical captures (same sha256) at this revision.",
        "captures": entries,
    }
    (MANIFEST_DIR / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(entries)} manifest entries to {MANIFEST_DIR.relative_to(ROOT)}/capture-manifest.json")
    print(f"wrote {len(entries)} PNGs to {EXTERNAL_OUT} (not committed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
