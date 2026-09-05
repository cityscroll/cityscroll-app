#!/usr/bin/env python3
"""Headless evidence capture for procurement-pursuit-decision Card 4.

Captures the real related-context-and-benchmarks output beneath the pursuit
snapshot for five states: both groups present with a large-cohort percentile
benchmark, an exact-chain-only case with the benchmark omitted below the rank
floor, a resemblance-only case (no exact chain, never worded as incumbency), a
medium-cohort case (rank shown, percentile withheld), and a control case
proving the section renders nothing when no candidate data is supplied.

Follows the same pattern as
tools/capture_procurement_pursuit_snapshot_evidence.py: render real
production HTML for a fixed set of named cases (via
tools/render_procurement_related_context_capture_fixtures.mjs) and record a
screenshot plus a manifest entry per case, at the project's standard
390x844 / 1440x900 viewports.

Screenshot binaries are NOT committed to this repository. They are written to
an external directory (default: a `docs-evidence/` sibling of the repository
root; override with CAPTURE_EXTERNAL_OUT) and only a manifest -- route,
viewport, revision, fixture/data vintage, the assertion each capture
demonstrates, and a sha256 content hash -- is committed under
docs/evidence/procurement-pursuit-decision/related-context/capture-manifest.json.

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
MANIFEST_DIR = ROOT / "docs" / "evidence" / "procurement-pursuit-decision" / "related-context"
EXTERNAL_OUT = Path(
    os.environ.get("CAPTURE_EXTERNAL_OUT")
    or (ROOT.parent / "docs-evidence" / "procurement-pursuit-decision" / "related-context")
)
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]

CASES = [
    (
        "related-context-both-groups",
        "procurement-detail",
        ["A"],
        "Fixture A (Parks, Playground reconstruction) with a caller-supplied exact predecessor (same EPIN, "
        "Acme Builders, 2022) and a resemblance-only candidate (same agency, overlapping title, Beta Contracting, "
        "2023); comparison population of 39 amounts (40 total with the subject) so the benchmark clears the "
        "percentile floor.",
        "Exact procurement history and related procurement context render as two visibly and semantically "
        "distinct groups beneath the pursuit snapshot; the amount benchmark states a percentile because the "
        "cohort (n=40) is at or above the existing large-cohort floor.",
    ),
    (
        "related-context-exact-only",
        "procurement-detail",
        ["A"],
        "Fixture A with only the exact predecessor candidate; comparison population of 3 amounts (4 total with "
        "the subject), below the existing small-cohort floor.",
        "Only the exact-procurement-history group renders; no related group, and no benchmark line at all -- a "
        "cohort below the rank floor is omitted entirely, never reported with false precision.",
    ),
    (
        "related-context-related-only",
        "procurement-detail",
        ["A"],
        "Fixture A with only the resemblance candidate (same agency, overlapping title, no shared identifier); "
        "no comparison population supplied.",
        "Only the related (resemblance) group renders, explicitly labeled as resemblance; the rendered markup "
        "never uses the word \"incumbent\" for this vendor.",
    ),
    (
        "related-context-rank-only-benchmark",
        "procurement-detail",
        ["A"],
        "Fixture A with the exact predecessor candidate; comparison population of 38 amounts (39 total with the "
        "subject), at or above the existing rank floor but below the percentile floor.",
        "The amount benchmark states a rank with the percentile explicitly withheld for a small-to-medium "
        "cohort, per the existing unchanged small-population policy.",
    ),
    (
        "related-context-none",
        "procurement-detail",
        ["A"],
        "Fixture A rendered with no relatedContextCandidates and no relatedContextPopulationAmounts supplied.",
        "No related-context section renders at all -- absence of caller-supplied history never becomes a "
        "fabricated \"no history found\" claim; the page renders normally with its existing sections.",
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
        ["node", str(ROOT / "tools" / "render_procurement_related_context_capture_fixtures.mjs")],
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
            has_section = 'data-related-context="1"' in html
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
                    "renders_related_context": has_section,
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
        "schema": "cityscroll.procurement_pursuit_decision_related_context_manifest.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "note": (
            "Card 4 (procurement-pursuit-decision): related procurement context and amount benchmarks beneath "
            "the pursuit snapshot. Screenshot binaries are not committed to this repository; they are written "
            "to an external directory (default a docs-evidence/ sibling of the repository root, override with "
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
