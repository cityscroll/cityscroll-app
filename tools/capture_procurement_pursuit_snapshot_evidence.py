#!/usr/bin/env python3
"""Headless evidence capture for procurement-pursuit-decision Card 3.

Captures the real pursuit-snapshot output for five acceptance-criterion-8
states (complete, partial, sparse, cancelled, superseded) plus a sixth
award-control case proving no snapshot renders there. The complete, sparse,
superseded, and award-control cases render through the real
renderProcurementDocument() (the exact function production /procurements/:id
pages call); the partial and cancelled cases render the real
buildPursuitSnapshot()/renderPursuitSnapshotHtml() composer -- the exact
functions site/app/money-history.mjs calls -- inside a minimal standalone
shell, since money-history.mjs itself paints into a live DOM rather than
returning a string.

Follows the same pattern as
tools/capture_procurement_opportunity_window_evidence.py: render real
production HTML for a fixed set of named cases (via
tools/render_procurement_pursuit_snapshot_capture_fixtures.mjs) and record a
screenshot plus a manifest entry per case, at the project's standard
390x844 / 1440x900 viewports.

Screenshot binaries are NOT committed to this repository. They are written to
an external directory (default: a `docs-evidence/` sibling of the repository
root; override with CAPTURE_EXTERNAL_OUT) and only a manifest -- route,
viewport, revision, fixture/data vintage, the assertion each capture
demonstrates, and a sha256 content hash -- is committed under
docs/evidence/procurement-pursuit-decision/pursuit-snapshot/capture-manifest.json.

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
MANIFEST_DIR = ROOT / "docs" / "evidence" / "procurement-pursuit-decision" / "pursuit-snapshot"
EXTERNAL_OUT = Path(
    os.environ.get("CAPTURE_EXTERNAL_OUT")
    or (ROOT.parent / "docs-evidence" / "procurement-pursuit-decision" / "pursuit-snapshot")
)
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]

CASES = [
    (
        "pursuit-snapshot-complete",
        "procurement-detail",
        ["A"],
        "passport_public_rfx observation ingested_at 2026-07-01T10:00:00Z; city_record observation ingested_at "
        "2026-07-02T10:00:00Z; rendered as of 2026-07-10",
        "Fixture A (Parks, Playground reconstruction) renders a complete pursuit snapshot: exact PASSPort/City "
        "Record identity, a 35-calendar-day response window, the July 22 pre-bid conference, the July 29 "
        "questions deadline, the August 5 due date, and PASSPort/official destinations -- above the existing "
        "Contract facts section.",
    ),
    (
        "pursuit-snapshot-partial",
        "notice-detail",
        ["B"],
        "test/solicitation_response_context.test.mjs completeSolicitation fixture (CAMA, Finance); no rendering-day clock involved",
        "Fixture B (CAMA, Finance) renders because it has a named identity, an agency, and an actionable due "
        "date; amount, method, and M/WBE are explicit unknowns (\"No published ...\"), never absent-looking negatives.",
    ),
    (
        "pursuit-snapshot-sparse",
        "procurement-detail",
        ["D"],
        "warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json S48020/0000541781; no rendering-day clock involved",
        "Fixture D (sparse MTA CBTC solicitation) still renders identity, agency, and literal source status "
        "(\"Current opportunity\") with an explicit unpublished amount and due date -- never a fabricated due date, "
        "never hidden merely because it is sparse.",
    ),
    (
        "pursuit-snapshot-cancelled",
        "notice-detail",
        ["B"],
        "Fixture B's identity with type_of_notice_description changed to Cancellation",
        "A cancellation notice never renders a pursuit snapshot or a response CTA; the page still renders "
        "normally with its existing sections.",
    ),
    (
        "pursuit-snapshot-superseded",
        "procurement-detail",
        ["A"],
        "Fixture A's canonical procurement with a later PASSPort round (due_date 2026-09-15) replacing the "
        "original due_date 2026-08-05",
        "A materially changed (superseded) round renders only its own current due date; the earlier round's "
        "due date never lingers on the page.",
    ),
    (
        "pursuit-snapshot-award-control",
        "procurement-detail",
        ["E"],
        "Fixture E as a canonical contract/award object (Playground reconstruction award, $250,000)",
        "The award control never renders a pursuit snapshot or any response CTA; it remains an award/contract-"
        "history page.",
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
        ["node", str(ROOT / "tools" / "render_procurement_pursuit_snapshot_capture_fixtures.mjs")],
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

        for label, surface, fixture_ids, data_vintage, assertion in CASES:
            html = fixtures[label]
            has_snapshot = 'class="pursuit-snapshot"' in html
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
                    "surface": surface,
                    "route": route_path,
                    "viewport": {"width": width, "height": height},
                    "revision": revision,
                    "fixture_ids": fixture_ids,
                    "data_vintage": data_vintage,
                    "renders_pursuit_snapshot": has_snapshot,
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
        "schema": "cityscroll.procurement_pursuit_decision_pursuit_snapshot_manifest.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "note": (
            "Card 3 (procurement-pursuit-decision): the pursuit snapshot on solicitation-stage procurement "
            "detail. Screenshot binaries are not committed to this repository; they are written to an "
            "external directory (default a docs-evidence/ sibling of the repository root, override with "
            "CAPTURE_EXTERNAL_OUT) named by 'external_filename' below, and this manifest is the reproducible, "
            "reviewable record of what each capture shows and why."
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
