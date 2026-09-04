#!/usr/bin/env python3
"""Headless evidence capture for procurement-pursuit-decision Card 0.

Captures the CURRENT (pre-Card-1..7) rendering of the fixtures recorded in
test/fixtures/procurement_pursuit_decision/fixture-ledger.json: the real
contracts browse page, procurement-detail documents for Fixtures A and D
(rendered via the production renderProcurementDocument()), the current
single-watch and multi-watch rollup email HTML (rendered via the production
subDigestHtml()/rollupDigestHtml() from worker/src/alerts.mjs), and a summary
of the fixture ledger itself.

Follows the same pattern as tools/capture_opportunity_calendar_evidence.py:
serve real pages from the tracked site/ tree (or a synthetic in-memory route
for the render-fixtures cases) and record a screenshot plus a manifest entry
per case, at the project's standard 390x844 / 1440x900 viewports.

Screenshot binaries are NOT committed to this repository. They are written to
an external directory (default: a `docs-evidence/` sibling of the repository
root; override with CAPTURE_EXTERNAL_OUT) and only a manifest — route,
viewport, revision, fixture/data vintage, the assertion each capture
demonstrates, and a sha256 content hash — is committed under
docs/evidence/procurement-pursuit-decision/baseline/capture-manifest.json.

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
MANIFEST_DIR = ROOT / "docs" / "evidence" / "procurement-pursuit-decision" / "baseline"
EXTERNAL_OUT = Path(
    os.environ.get("CAPTURE_EXTERNAL_OUT")
    or (ROOT.parent / "docs-evidence" / "procurement-pursuit-decision" / "baseline")
)
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]

LEDGER_PATH = ROOT / "test" / "fixtures" / "procurement_pursuit_decision" / "fixture-ledger.json"
MTA_FIXTURES_PATH = ROOT / "warehouse" / "fixtures" / "authority-native-procurement" / "mta-opportunities.v1.json"

RENDERED_CASES = [
    (
        "procurement-detail-fixture-a",
        "procurement-detail",
        "Fixture A: dense exact-join solicitation (procurement:epin-2026-07)",
        ["A"],
        "passport_public_rfx observation ingested_at 2026-07-01T10:00:00Z; "
        "city_record observation ingested_at 2026-07-02T10:00:00Z; rendered as of 2026-07-10",
        "renderProcurementDocument() surfaces the exact PASSPort release/City Record "
        "observations and process events for a dense, exact-join procurement, ahead of any "
        "Card-2 opportunity-window derivation.",
    ),
    (
        "procurement-detail-fixture-d",
        "procurement-detail",
        "Fixture D: sparse real solicitation (procurement:solicitation:S48020)",
        ["D"],
        "warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json retrieved_at 2026-08-28T14:00:00.000Z",
        "renderProcurementDocument() on a sparse real object currently prints the raw "
        "estimated_value (\"$100M+\") and opening_date as literal Amount/End date text, "
        "rather than explicit not-published placeholders.",
    ),
    (
        "email-single-watch",
        "email-preview",
        "Current single-watch digest containing Fixture C (solicitation) and Fixture E (award control)",
        ["C", "E"],
        "test/digest_preview_awareness.test.mjs FIX-PREV-SOL-1/FIX-PREV-AWD-1 fixture rows; rendered as of 2026-08-02",
        "subDigestHtml() renders today's single-watch subject/body hierarchy with no "
        "procurement-specific normalized atom, ahead of Card 1.",
    ),
    (
        "email-multi-watch-rollup",
        "email-preview",
        "Current multi-watch rollup containing Fixtures C, D, and E",
        ["C", "D", "E"],
        "same fixture rows as email-single-watch plus Fixture D's digest row; rendered as of 2026-08-02",
        "rollupDigestHtml() renders every watch's section (the every-watch honesty mechanism) "
        "with no lead-opportunity selection, ahead of Card 1.",
    ),
    (
        "fixture-ledger-summary",
        "fixture-ledger",
        "Summary table of test/fixtures/procurement_pursuit_decision/fixture-ledger.json",
        ["A", "B", "C", "D", "E", "F"],
        "test/fixtures/procurement_pursuit_decision/fixture-ledger.json baseline_revision c2132a37f5bfedd0d65b6c3fd401e01413d6c0b7",
        "Renders the committed fixture ledger as a table so the six shared fixtures and their "
        "expected unknowns/UI surfaces are visible at a glance.",
    ),
]

BROWSE_CASES = [
    (
        "contracts-browse",
        "/browse/contracts/",
        "Current contracts browse page",
        [],
        "site/data/procurement_browse_query_rows.json as tracked at this revision",
        "The real Contracts Browse route rendered with no stubbed data, before any "
        "pursuit-decision surfacing changes.",
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
        ["node", str(ROOT / "tools" / "render_procurement_pursuit_decision_baseline_fixtures.mjs")],
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


def capture_one(browser, revision, label, surface, route_path_or_html, description, fixture_ids, data_vintage, assertion, *, is_route, entries):
    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
        page = context.new_page()
        if is_route:
            base, route_path = route_path_or_html
            page.goto(f"{base}{route_path}", wait_until="networkidle", timeout=20000)
            route = route_path
        else:
            base, route_path, html = route_path_or_html
            page.route("https://fonts.googleapis.com/**", lambda r: r.abort())
            page.route("https://fonts.gstatic.com/**", lambda r: r.abort())
            page.route(f"{base}{route_path}", fulfill_html(html))
            page.goto(f"{base}{route_path}", wait_until="networkidle", timeout=20000)
            route = route_path
        filename = f"{label}-{width}x{height}.png"
        shot = EXTERNAL_OUT / filename
        page.screenshot(path=str(shot), full_page=True)
        axe_result = run_axe(page)
        entries.append({
            "case": label,
            "surface": surface,
            "route": route,
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

        for label, surface, description, fixture_ids, data_vintage, assertion in RENDERED_CASES:
            html = fixtures[label]
            route_path = f"/_capture/{label}"
            capture_one(
                browser, revision, label, surface, (base, route_path, html), description,
                fixture_ids, data_vintage, assertion, is_route=False, entries=entries,
            )

        for label, route_path, description, fixture_ids, data_vintage, assertion in BROWSE_CASES:
            capture_one(
                browser, revision, label, surface="contracts-browse", route_path_or_html=(base, route_path),
                description=description, fixture_ids=fixture_ids, data_vintage=data_vintage, assertion=assertion,
                is_route=True, entries=entries,
            )

        browser.close()

    server.shutdown()

    manifest = {
        "schema": "cityscroll.procurement_pursuit_decision_baseline_manifest.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "note": (
            "Pre-Card-1..7 baseline capture. No production code was changed to produce these "
            "renders. Screenshot binaries are not committed to this repository; they are written "
            "to an external directory (default a docs-evidence/ sibling of the repository root, "
            "override with CAPTURE_EXTERNAL_OUT) named by 'external_filename' below, and this "
            "manifest is the reproducible, reviewable record of what each capture shows and why."
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
