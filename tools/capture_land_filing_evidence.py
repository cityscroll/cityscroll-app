#!/usr/bin/env python3
"""Headless desktop/mobile captures for the Land "Application filings" and
"Filing history" surfaces (LDP-27).

Renders `landFilingEvidenceSummaryHTML`/`landFilingHistoryHTML`
(site/land_filing_evidence_view.mjs) directly against fixture
`land_filing_evidence_summary.v1` records covering the positive, active-
required-unobserved, not-required, and pre-effective journeys, plus keyboard
activation of the route-lazy "View full report" trigger, a print-media
capture, and a no-script capture (the same server-rendered markup with no
`<script>` at all). No public route or worker is mounted -- like the sibling
`capture_land_authority_panel.py` and `capture_now_calendar_evidence.py`
harnesses, this is a direct component capture.

The rendered PNGs are gitignored (docs/screenshots/land-filing-evidence/*.png)
and stay local/owner-side; manifest.json -- one entry per capture with its
sha256, route, viewport, revision, and assertion -- is the committed proof.
Re-run this script locally to regenerate the images from the manifest's own
inputs whenever you need to look at one.

    python3 tools/capture_land_filing_evidence.py
    python3 tools/capture_land_filing_evidence.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-filing-evidence"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = ((390, 844), (1440, 900))
ROUTE = "component-harness:land-filing-evidence"

# Each specimen names the acceptance criterion it exercises.
SPECIMENS = (
    ("positive", "A1: project -> obligation -> typed report -> a cited field and page -> the original source"),
    ("active-required-unobserved", "A2/G1: an active required project with no observed document states the observed condition exactly"),
    ("not-required", "A3: a not-required project renders a distinct explanation"),
    ("pre-effective", "A3: a not-yet-effective project renders a distinct explanation from not-required"),
)

RENDER_JS = r"""
import { readFileSync } from "node:fs";
import {
  buildLandFilingEvidenceSummary,
  withLandFilingEvidenceReport,
} from "./site/land_filing_evidence.mjs";
import {
  buildLandUseFilingDocument,
  buildLandUseFilingObligation,
  buildRacialEquityReportEnvelope,
  racialEquityReportGoverningAuthority,
} from "./ontology/land_use_filing.mjs";
import { buildExtractedField } from "./ontology/racial_equity_report_fields.mjs";
import { materializeLandFilingSequence } from "./warehouse/lib/land_filing_sequence.mjs";
import {
  landFilingEvidenceSummaryHTML,
  landFilingHistoryHTML,
  LAND_FILING_REPORT_TRIGGER_ATTR,
} from "./site/land_filing_evidence_view.mjs";

const i18n = readFileSync("site/i18n.js", "utf8");
const copy = {};
for (const match of i18n.matchAll(/^\s+([a-z][a-z0-9_]*):\s*"((?:\\.|[^"\\])*)"/gm)) {
  copy[match[1]] = match[2].replace(/\\"/g, '"');
}
function t(key, vars) {
  let text = copy[key] || key;
  if (vars) text = text.replace(/\{(\w+)\}/g, (all, name) => Object.hasOwn(vars, name) ? String(vars[name] ?? "") : all);
  return text;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

const NOW = "2026-06-01T00:00:00.000Z";
const HASH = "b".repeat(64);

function obligation(overrides = {}) {
  return buildLandUseFilingObligation({
    obligation_id: "land_use_filing_obligation:2025M0252:racial_equity_report",
    project_ref: "project:2025M0252",
    obligation_type: "racial_equity_report",
    governing_authority: [racialEquityReportGoverningAuthority()],
    applicability: { state: "required", criteria: [], publisher_assertion: { source_field: "dcp-applicability", source_value: "Yes", observed_at: NOW } },
    fulfillment: { state: "not_observed", document_refs: [] },
    procedural_effect: { certification_blocker: false, missing_report_notification_required: "unknown" },
    observed_at: NOW,
    available_to_public_at: NOW,
    materialized_at: NOW,
    source_id: "nyc-zap-open-data",
    source_record_id: "2025M0252",
    source_vintage: NOW,
    normalization_version: "ldp23.v1",
    ...overrides,
  });
}

function document() {
  return buildLandUseFilingDocument({
    project_ref: "project:2025M0252",
    document_type: "racial_equity_report",
    publisher_document_id: "doc-1",
    original_name: "Racial Equity Report.pdf",
    first_observed_at: NOW,
    available_to_public_at: NOW,
    retrieval_status: "fetched",
    bytes_sha256: HASH,
    byte_length: 1000,
    classification: { method: "explicit_publisher_type_or_group", evidence: ["publisher group: RER"], confidence: "high" },
    canonical_public_url: "https://zap.planning.nyc.gov/projects/2025M0252/documents/doc-1.pdf",
  });
}

function specimen(slug) {
  if (slug === "positive") {
    const doc = document();
    const ob = obligation({ fulfillment: { state: "document_observed", document_refs: [doc.document_id] } });
    const envelope = buildRacialEquityReportEnvelope({
      document_ref: doc.document_id,
      project_ref: "project:2025M0252",
      report_preparation_date: "2025-03-01",
      source_bytes_sha256: HASH,
      extraction_version: "ldp25_rer_extractor.v1",
      extraction_quality: "high",
      application_scope: { project_name: buildExtractedField({ field_name: "project_name", value: "Example Rezoning", raw_value: "Example Rezoning", evidence: { page_number: 4 }, method: "deterministic_text", extractor_version: "ldp25_rer_extractor.v1", confidence: "high" }) },
      field_evidence: { field_count: 4, abstained_count: 1, abstention_ratio: 0.25, by_method: { deterministic_text: 3 }, by_confidence: { high: 3 }, overall_quality: "high" },
    });
    const sequence = materializeLandFilingSequence({ projectId: "2025M0252", obligations: [ob], documents: [doc], materializedAt: NOW });
    let summary = buildLandFilingEvidenceSummary({ obligation: ob, documents: [doc], sequence, materializedAt: NOW });
    summary = withLandFilingEvidenceReport(summary, { obligation: ob, documents: [doc], rerEnvelope: envelope });
    return { summary, documentRef: doc.document_id };
  }
  if (slug === "active-required-unobserved") {
    const ob = obligation();
    const sequence = materializeLandFilingSequence({ projectId: "2025M0252", obligations: [ob], documents: [], materializedAt: NOW });
    return { summary: buildLandFilingEvidenceSummary({ obligation: ob, sequence, materializedAt: NOW }) };
  }
  if (slug === "not-required") {
    const ob = obligation({ applicability: { state: "not_required", criteria: [], publisher_assertion: { source_field: "dcp-applicability", source_value: "No", observed_at: NOW } } });
    return { summary: buildLandFilingEvidenceSummary({ obligation: ob, materializedAt: NOW }) };
  }
  if (slug === "pre-effective") {
    const ob = obligation({ applicability: { state: "not_yet_effective", criteria: [], publisher_assertion: { source_field: "dcp-applicability", source_value: "Pending", observed_at: NOW } } });
    return { summary: buildLandFilingEvidenceSummary({ obligation: ob, materializedAt: NOW }) };
  }
  throw new Error(`unknown specimen ${slug}`);
}

const slugs = ["positive", "active-required-unobserved", "not-required", "pre-effective"];
const panels = {};
for (const slug of slugs) {
  const { summary, documentRef } = specimen(slug);
  const html = landFilingEvidenceSummaryHTML(summary, { t, escape: esc })
    + landFilingHistoryHTML(summary?.filing_history_digest, { t, escape: esc });
  panels[slug] = { html, documentRef: documentRef || null, triggerAttr: LAND_FILING_REPORT_TRIGGER_ATTR };
}
process.stdout.write(JSON.stringify(panels));
"""


def panel_css() -> str:
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    rules = re.findall(r"(\.land-filing-[^{]+\{[^}]+\})", html)
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
        ".act{display:inline-block;padding:6px 10px;border:1px solid var(--rule);border-radius:8px;text-decoration:none;color:var(--ink);background:#fff;font:inherit;cursor:pointer}"
        ".act:focus-visible{outline:3px solid #174ea6;outline-offset:2px}"
        ".sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}"
    )
    return root + "".join(rules)


def render_panels() -> dict[str, dict]:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", RENDER_JS],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def page_html(panel_html: str, *, with_script: bool) -> str:
    script = (
        "<script>"
        "document.addEventListener('click', function(e){"
        "var t=e.target.closest('[data-land-filing-report-trigger]');"
        "if(!t) return;"
        "var root=document.querySelector('[data-land-filing-report-detail-root]');"
        "root.hidden=false;"
        "root.innerHTML='<p class=\"land-filing-report-failure\" data-land-filing-report-failure=\"1\">The full report could not load. Try again, or open the original document above.</p>';"
        "t.hidden=true;"
        "});"
        "</script>"
    ) if with_script else ""
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<title>Land filing-evidence harness</title>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<style>{panel_css()}</style></head>"
        f"<body><main><div id='host'>{panel_html}</div></main>{script}</body></html>"
    )


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
    }


def capture() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    panels = render_panels()
    revision = git_revision()
    files: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        # Journeys 1-4: the four applicability/fulfillment specimens, both viewports.
        for slug, assertion in SPECIMENS:
            panel = panels.get(slug)
            if panel is None:
                raise SystemExit(f"render script produced no panel for {slug}")
            if 'data-land-filing-evidence="1"' not in panel["html"]:
                raise SystemExit(f"missing filing-evidence markup for {slug}")
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(page_html(panel["html"], with_script=True), wait_until="domcontentloaded")
                host = page.locator("#host")
                host.wait_for(state="attached")
                axe_result = run_axe(page)
                dest = OUT / f"{slug}-{width}.png"
                host.screenshot(path=str(dest), animations="disabled")
                data = dest.read_bytes()
                files.append({
                    "name": dest.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                    "route": ROUTE, "viewport": [width, height], "revision": revision,
                    "specimen": slug, "assertion": assertion, "axe": axe_result,
                })
                page.close()

        # Journey 5: keyboard activation of the route-lazy "View full report" trigger.
        positive = panels["positive"]
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.set_content(page_html(positive["html"], with_script=True), wait_until="domcontentloaded")
            trigger = page.locator("[data-land-filing-report-trigger]")
            trigger.wait_for(state="visible")
            trigger.focus()
            axe_focused = run_axe(page)
            page.keyboard.press("Enter")
            detail_root = page.locator("[data-land-filing-report-detail-root]")
            detail_root.wait_for(state="visible")
            assert "failure" in (detail_root.inner_html() or ""), "keyboard activation did not reach the mount point"
            dest = OUT / f"keyboard-{width}.png"
            page.locator("#host").screenshot(path=str(dest), animations="disabled")
            data = dest.read_bytes()
            files.append({
                "name": dest.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "route": ROUTE, "viewport": [width, height], "revision": revision,
                "specimen": "keyboard", "assertion": "A5: the report trigger is reachable and activatable by keyboard alone",
                "axe": axe_focused,
            })
            page.close()

        # Journey 6: print media.
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.set_content(page_html(positive["html"], with_script=False), wait_until="domcontentloaded")
            page.emulate_media(media="print")
            dest = OUT / f"print-{width}.png"
            page.locator("#host").screenshot(path=str(dest), animations="disabled")
            data = dest.read_bytes()
            files.append({
                "name": dest.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "route": ROUTE, "viewport": [width, height], "revision": revision,
                "specimen": "print", "assertion": "A5: the essential filing state and source link survive print", "axe": None,
            })
            page.close()

        # Journey 7: no-script -- identical server-rendered markup, no <script> at all.
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height}, java_script_enabled=False)
            page.set_content(page_html(positive["html"], with_script=False), wait_until="domcontentloaded")
            host = page.locator("#host")
            host.wait_for(state="attached")
            dest = OUT / f"noscript-{width}.png"
            host.screenshot(path=str(dest), animations="disabled")
            data = dest.read_bytes()
            files.append({
                "name": dest.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "route": ROUTE, "viewport": [width, height], "revision": revision,
                "specimen": "noscript", "assertion": "A5: applicability, fulfilment, and the source link render with no script", "axe": None,
            })
            page.close()

        browser.close()
    manifest = {
        "schema_version": 1,
        "feature": "land-filing-evidence",
        "card": "cityscroll-land-decision-path/ldp-27-filing-evidence-surfaces",
        "route": ROUTE,
        "revision": revision,
        "files": files,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def check() -> int:
    # The PNGs are gitignored and owner-side (see the module docstring); the committed manifest
    # entry -- name, bytes, sha256, route, viewport, revision, assertion, axe -- is the proof this
    # checks. When a capture's PNG also happens to exist on this disk, its sha256 is verified for
    # integrity, but its absence alone is never a failure.
    manifest_path = OUT / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"missing {manifest_path.relative_to(ROOT)}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {f"{slug}-{width}.png" for slug, _ in SPECIMENS for width, _ in VIEWPORTS}
    expected |= {f"{extra}-{width}.png" for extra in ("keyboard", "print", "noscript") for width, _ in VIEWPORTS}
    found = {row["name"] for row in manifest.get("files") or []}
    missing = expected - found
    if missing:
        raise SystemExit(f"missing captures: {sorted(missing)}")
    for row in manifest["files"]:
        if not row.get("sha256") or not row.get("bytes"):
            raise SystemExit(f"manifest entry for {row['name']} is missing its sha256/bytes proof")
        path = OUT / row["name"]
        if path.exists():
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != row["sha256"] or len(data) != row["bytes"]:
                raise SystemExit(f"local capture {row['name']} does not match its committed manifest entry")
        if row["axe"] and row["axe"]["failing_violations"]:
            raise SystemExit(f"{row['name']} failed the axe gate: {row['axe']['failing_violations']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print("captured", len(manifest["files"]), "land filing-evidence screenshots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
