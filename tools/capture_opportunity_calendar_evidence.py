#!/usr/bin/env python3
"""Headless evidence capture for CBICS-07 procurement/property opportunity bundles.

Renders the real production output — renderProcurementDocument() and
renderPropertyCommercialDetail() over the shared CBICS-01/02 opportunity-bundle
pipeline (site/opportunity_calendar.mjs) — via
tools/render_opportunity_calendar_capture_fixtures.mjs, then serves each
document from the real local site (so committed assets — compact_calendar.css,
brand.css, civic-documents.css, property.css — load exactly as production
would) and records a screenshot, the vendored axe-core accessibility gate, and
a receipt naming route, viewport, revision, source/confidence state, and
assertion for each case: a dense procurement bundle (conference, questions,
proposal), a sparse procurement (no calendar chrome, existing observed events
kept), a low-confidence/derived-excluded procurement deadline, a dense
property bundle (hearing, two showings, bid deadline), a sparse property
notice (no calendar chrome), and a property bundle with one low-confidence
date excluded from confirmed cells beside the retained confirmed ones.

No public route is created; capture pages are fulfilled in-memory at a
synthetic path and never written into the tracked site/ tree.
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "opportunity-calendar"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
TODAY = "2026-07-10"

CASES = [
    ("procurement-dense", "procurement", "conference + questions + proposal dates form the bundle"),
    ("procurement-sparse", "procurement", "one publisher date only — no calendar chrome, observed events kept"),
    ("procurement-exclusion", "procurement", "a low-confidence derived deadline is excluded — sparse, no chrome"),
    ("property-dense", "property", "hearing + two showings + bid deadline form the bundle"),
    ("property-sparse", "property", "one dated event only — no calendar chrome"),
    ("property-exclusion", "property", "a low-confidence date is excluded; the confirmed bundle still renders"),
]


class Handler(SimpleHTTPRequestHandler):
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
        ["node", str(ROOT / "tools" / "render_opportunity_calendar_capture_fixtures.mjs")],
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


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    fixtures = render_fixtures()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"

    receipts = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for label, surface, description in CASES:
            html = fixtures[label]
            route_path = f"/_capture/{label}"
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
                page = context.new_page()
                page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
                page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
                page.route(f"{base}{route_path}", fulfill_html(html))
                page.goto(f"{base}{route_path}", wait_until="networkidle", timeout=20000)
                has_month = page.locator(".compact-month-grid").count() > 0
                has_flag_cancelled = page.locator(".compact-month-occ-flag-cancelled").count() > 0
                observed_present = page.locator("text=Observed events").count() > 0 if surface == "procurement" else True
                shot = OUT / f"{label}-{width}x{height}.png"
                page.screenshot(path=str(shot), full_page=True)
                axe_result = run_axe(page)
                receipts.append({
                    "case": label,
                    "surface": surface,
                    "route": route_path,
                    "viewport": {"width": width, "height": height},
                    "today": TODAY,
                    "source_confidence_state": description,
                    "renders_month": has_month,
                    "any_cancelled_flag": has_flag_cancelled,
                    "screenshot": str(shot.relative_to(ROOT)),
                    "axe": axe_result,
                    "assertion": (
                        f"case={label} surface={surface} at {width}x{height} "
                        f"renders_month={has_month} observed_events_present={observed_present} "
                        f"axe_passes={axe_result['passes']}"
                    ),
                })
                page.close()
                context.close()
        browser.close()

    server.shutdown()

    all_axe_pass = all(r["axe"]["passes"] for r in receipts)
    expected_month = {"procurement-dense": True, "procurement-sparse": False, "procurement-exclusion": False,
                       "property-dense": True, "property-sparse": False, "property-exclusion": True}
    all_month_expected = all(r["renders_month"] == expected_month[r["case"]] for r in receipts)
    receipt = {
        "schema": "cityscroll.opportunity_calendar_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "today": TODAY,
        "all_axe_pass": all_axe_pass,
        "all_month_render_expected": all_month_expected,
        "captures": receipts,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"wrote {len(receipts)} captures under {OUT}")
    if not all_axe_pass:
        print("AXE FAILURES DETECTED", file=sys.stderr)
        return 1
    if not all_month_expected:
        print("MONTH-RENDER EXPECTATION MISMATCH", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
