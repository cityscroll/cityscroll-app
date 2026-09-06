#!/usr/bin/env python3
"""Headless desktop/mobile captures for the LDP-16 "Follow next decision"
eligibility gate on the Land "Where this stands" panel.

Renders the committed authority_summary corpus through the resident panel
module (site/land_authority_summary_view.mjs), gated by the LDP-16 reliability
measurement (site/land_next_decision_watch.mjs), for three real specimens
drawn from the committed corpus:

  - eligible:   2026Q0210 (resolved Council stage, normalized actor) ->
                "Follow next decision"
  - ineligible: 2025M0252 (resolved but terminal CPC stage, no materialized
                next transition) -> "Follow this project", with an explicit
                `data-land-authority-next-decision-reason`
  - unknown:    2020M0385 (unresolved procedure) -> "Follow this project",
                with an explicit ineligible reason rather than a silent
                absence

Runs the vendored axe-core (test/functional/assets/axe.min.js -- no network
dependency) against each capture at both review widths. The rendered PNGs are
gitignored (docs/screenshots/land-next-decision-watch/*.png) and stay
local/owner-side; manifest.json -- one entry per capture with its sha256,
route, viewport, revision, data vintage, assertion, and axe result -- is the
committed proof.

    python3 tools/capture_land_next_decision_watch.py
    python3 tools/capture_land_next_decision_watch.py --check
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
OUT = ROOT / "docs" / "screenshots" / "land-next-decision-watch"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = ((390, 844), (1440, 900))
ROUTE = "component-harness:land-next-decision-watch"

# Each specimen is a real project id from the committed
# site/data/land_authority_summary.json corpus, drawn from LDP-16's own
# nextDecisionEligibility() reasons rather than a hand-picked guess.
SPECIMENS = (
    ("2026Q0210", "eligible", "A1: reliability GO + resolved Council stage/actor exposes Follow next decision"),
    ("2025M0252", "ineligible", "A1: a resolved but terminal CPC stage falls back to Follow this project with an explicit reason"),
    ("2020M0385", "unknown", "A1: an unresolved procedure shows an explicit ineligible reason, never a silent absence"),
)

RENDER_JS = r"""
import { readFileSync } from "node:fs";
import { landAuthoritySummaryHTML, landAuthorityPanelProjection, rememberLandAuthoritySummaries } from "./site/land_authority_summary_view.mjs";

const payload = JSON.parse(readFileSync("site/data/land_authority_summary.json", "utf8"));
rememberLandAuthoritySummaries(payload);
const i18n = readFileSync("site/i18n.js", "utf8");
const copy = {};
for (const match of i18n.matchAll(/^\s+(land_[a-z0-9_]+):\s*"((?:\\.|[^"\\])*)"/gm)) {
  copy[match[1]] = match[2].replace(/\\"/g, '"');
}
function t(key, vars) {
  let text = copy[key] || key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (all, name) => Object.hasOwn(vars, name) ? String(vars[name] ?? "") : all);
  }
  return text;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
const ids = ["2026Q0210", "2025M0252", "2020M0385"];
const out = {};
for (const id of ids) {
  const summary = payload.summaries[id];
  out[id] = {
    html: landAuthoritySummaryHTML(summary, { t, escape: esc }),
    projection: landAuthorityPanelProjection(summary),
  };
}
process.stdout.write(JSON.stringify({ generated_at: payload.generated_at, panels: out }));
"""


def panel_css() -> str:
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    rules = re.findall(r"(\.land-authority-[^{]+\{[^}]+\})", html)
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
        ".act{display:inline-block;padding:6px 10px;border:1px solid var(--rule);border-radius:8px;text-decoration:none;color:var(--ink);background:#fff}"
    )
    return root + "".join(rules)


def render_panels() -> dict:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", RENDER_JS],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def page_html(panel_html: str) -> str:
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<title>Land next-decision watch harness</title>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<style>{panel_css()}</style></head>"
        f"<body><main>{panel_html}</main></body></html>"
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
    rendered = render_panels()
    panels = rendered["panels"]
    data_vintage = rendered["generated_at"]
    revision = git_revision()
    files: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for project_id, slug, assertion in SPECIMENS:
            entry = panels.get(project_id) or {}
            html = entry.get("html") or ""
            if 'data-land-authority-summary="1"' not in html:
                raise SystemExit(f"missing panel markup for {project_id}")
            expected_target = "next_decision" if slug == "eligible" else "project"
            if entry["projection"]["watch_target"] != expected_target:
                raise SystemExit(f"{project_id} watch_target {entry['projection']['watch_target']!r} != {expected_target!r}")
            if slug != "eligible" and not entry["projection"]["next_decision_ineligible_reason"]:
                raise SystemExit(f"{project_id} is ineligible but carries no explicit reason")
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(page_html(html), wait_until="domcontentloaded")
                panel = page.locator("[data-land-authority-summary='1']").first
                panel.wait_for(state="visible")
                assert panel.get_attribute("data-project-id") == project_id
                axe_result = run_axe(page)
                dest = OUT / f"{slug}-{width}.png"
                panel.screenshot(path=str(dest), animations="disabled")
                data = dest.read_bytes()
                files.append({
                    "name": dest.name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "route": ROUTE,
                    "viewport": [width, height],
                    "revision": revision,
                    "data_vintage": data_vintage,
                    "specimen": slug,
                    "project_id": project_id,
                    "assertion": assertion,
                    "axe": axe_result,
                })
                page.close()
        browser.close()
    manifest = {
        "schema_version": 1,
        "feature": "land-next-decision-watch",
        "card": "cityscroll-engineering/procedure-aware-watches",
        "route": ROUTE,
        "revision": revision,
        "files": files,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def check() -> int:
    manifest_path = OUT / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("missing docs/screenshots/land-next-decision-watch/manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {f"{slug}-{width}.png" for _, slug, _ in SPECIMENS for width, _ in VIEWPORTS}
    found = {row["name"] for row in manifest.get("files") or []}
    missing = expected - found
    if missing:
        raise SystemExit(f"missing captures: {sorted(missing)}")
    for row in manifest["files"]:
        if row["axe"] and row["axe"]["failing_violations"]:
            raise SystemExit(f"{row['name']} failed the axe gate: {row['axe']['failing_violations']}")
        if not row.get("sha256") or not row.get("revision") or not row.get("data_vintage"):
            raise SystemExit(f"{row['name']} manifest entry missing required provenance fields")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print("captured", len(manifest["files"]), "land next-decision watch screenshots (axe-checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
