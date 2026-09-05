#!/usr/bin/env python3
"""Headless desktop/mobile captures for the Land phase-spine role strip (LDP-21).

Renders `landPhaseRoleStripHTML` against three fixture-driven specimens — a
resolved current stage with an observed row underneath (known), a resolved
future stage with zero observed rows underneath (incomplete), and a
statutory-days-after-review window with an alternate EIS day count
(calculated-window) — through the resident phase-spine CSS, then screenshots
each at 390x844 and 1440x900.

    python3 tools/capture_land_phase_role_strip.py
    python3 tools/capture_land_phase_role_strip.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-phase-role-strip"
EVIDENCE_PATH = ROOT / "docs" / "evidence" / "land-phase-role-strip.json"
VIEWPORTS = ((390, 844), (1440, 900))

# (slug, fixture, phase_id, assertion)
SPECIMENS = (
    (
        "known",
        "2024Q0419",
        "cpc",
        "current, resolved stage with a real institutional actor and an observed vote row underneath",
    ),
    (
        "incomplete",
        "2024Q0356",
        "cpc",
        "resolved future stage renders its normative header with zero observed rows underneath — "
        "the expected CPC vote stays an expectation until a source observes it",
    ),
    (
        "calculated-window",
        "ulurp_control_2023X0100",
        "community_board",
        "statutory_days window renders labelled as calculated, never as an observed date",
    ),
)

RENDER_JS = r"""
import { readFileSync } from "node:fs";
import { buildLandPhaseView } from "./site/land_phase_spine.mjs";
import { buildLandPhaseRoleStrip, landPhaseRoleStripHTML } from "./site/land_role_strip.mjs";

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
function fdate(value) {
  return value || "\u2014";
}

const geography = JSON.parse(readFileSync("site/data/community_board_geography_lookup.json", "utf8"));

const specimens = [
  { slug: "known", fixture: "2024Q0419", phase: "cpc", geography: false },
  { slug: "incomplete", fixture: "2024Q0356", phase: "cpc", geography: false },
  { slug: "calculated-window", fixture: "ulurp_control_2023X0100", phase: "community_board", geography: true },
];

const panels = {};
for (const spec of specimens) {
  const fixture = JSON.parse(readFileSync(`test/fixtures/land_phase_spine/${spec.fixture}.json`, "utf8"));
  const openData = spec.geography
    ? { ...fixture.open_data, community_district: "M05", borough: "Manhattan" }
    : fixture.open_data;
  const view = buildLandPhaseView(fixture.spine, {
    open_data: openData,
    actions: fixture.actions,
    portal_url: fixture.portal_url,
    public_status: fixture.public_status,
    project_id: fixture.project_id,
    geography: spec.geography ? geography : undefined,
  });
  const strip = buildLandPhaseRoleStrip(view, spec.phase);
  if (!strip) throw new Error(`no role strip resolved for ${spec.slug} (${spec.fixture}/${spec.phase})`);
  const roleStripHTML = landPhaseRoleStripHTML(strip, { t, escape: esc });
  const phase = view.phases.find((p) => p.id === spec.phase);
  const observedHTML = (phase.aggregates || []).length
    ? phase.aggregates.map((a) => `<div class="land-phase-row"><div class="land-phase-row-title" lang="en" dir="ltr">${esc(a.title)}</div><div class="land-phase-row-meta">${esc(fdate(a.first))}${a.statuses?.length ? ` \u00b7 ${esc(a.statuses.join(", "))}` : ""}</div></div>`).join("")
    : `<div class="land-phase-row"><div class="land-phase-row-meta">${esc(t("land_spine_phase_empty"))}</div></div>`;
  panels[spec.slug] = {
    project_id: view.project_id,
    phase_id: spec.phase,
    phase_state: phase.state,
    event_count: phase.event_count,
    html: `<details class="land-phase current-phase" open data-land-phase-panel="${esc(spec.phase)}" data-land-phase-state="${esc(phase.state)}"><summary><span class="land-phase-name">${esc(spec.phase)}</span></summary><div class="land-phase-body">${roleStripHTML}${observedHTML}</div></details>`,
  };
}
process.stdout.write(JSON.stringify(panels));
"""


def panel_css() -> str:
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    rules = re.findall(r"(\.land-(?:role-strip|phase)[^{]*\{[^}]+\})", html)
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
        "details.land-phase{border:1px solid var(--rule);border-radius:8px;padding:8px 12px;margin:0 0 12px}"
        ".land-role-strip{border:1px solid var(--oxblood);border-radius:6px;padding:8px 10px;margin:0 0 10px;background:#fbeceb}"
        ".land-role-strip-kicker{font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--oxblood)}"
        ".land-phase-row{padding:4px 0;border-top:1px dashed var(--rule)}"
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
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<style>{panel_css()}</style></head><body>{panel_html}</body></html>"
    )


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout.strip()


def capture() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    panels = render_panels()
    revision = git_revision()
    files: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for slug, fixture, phase_id, assertion in SPECIMENS:
            panel = panels.get(slug)
            if not panel:
                raise SystemExit(f"missing rendered panel for {slug}")
            html = panel["html"]
            if 'data-land-authority-kind="role_definition"' not in html:
                raise SystemExit(f"missing role-strip markup for {slug}")
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(page_html(html), wait_until="domcontentloaded")
                strip = page.locator('[data-land-role-strip="1"]').first
                strip.wait_for(state="visible")
                dest = OUT / f"{slug}-{width}.png"
                page.locator("details.land-phase").first.screenshot(path=str(dest), animations="disabled")
                data = dest.read_bytes()
                files.append({
                    "name": dest.name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "slug": slug,
                    "route": f"/land/{panel['project_id']}#land-phase-{phase_id}",
                    "viewport": [width, height],
                    "revision": revision,
                    "source_vintage": f"test/fixtures/land_phase_spine/{fixture}.json",
                    "project_id": panel["project_id"],
                    "phase_id": phase_id,
                    "phase_state": panel["phase_state"],
                    "event_count": panel["event_count"],
                    "assertion": assertion,
                    "screenshot": str(dest.relative_to(ROOT)),
                })
                page.close()
        browser.close()
    manifest = {
        "schema": "cityscroll.land-phase-role-strip-receipt.v1",
        "card": "cityscroll-land-decision-path/ldp-21-authority-panel-historical-semantics",
        "browser_mode": "headless chromium (Playwright)",
        "revision": revision,
        "specimens": [
            {"slug": s, "fixture": f, "phase_id": p, "assertion": a} for s, f, p, a in SPECIMENS
        ],
        "viewports": [list(v) for v in VIEWPORTS],
        "files": files,
    }
    EVIDENCE_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def check() -> int:
    if not EVIDENCE_PATH.exists():
        raise SystemExit(f"missing {EVIDENCE_PATH.relative_to(ROOT)}")
    manifest = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
    expected = {f"{slug}-{width}.png" for slug, _, _, _ in SPECIMENS for width, _ in VIEWPORTS}
    found = {row["name"] for row in manifest.get("files") or []}
    missing = expected - found
    if missing:
        raise SystemExit(f"missing captures: {sorted(missing)}")
    for row in manifest["files"]:
        path = ROOT / row["screenshot"]
        if not path.exists() or path.stat().st_size < 500:
            raise SystemExit(f"empty or missing capture {row['name']}")
        if not row.get("route") or not row.get("revision") or not row.get("source_vintage") or not row.get("assertion"):
            raise SystemExit(f"{row['name']} is missing route/revision/source_vintage/assertion")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    capture()
    print("captured", len(SPECIMENS) * len(VIEWPORTS), "land phase-spine role-strip screenshots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
