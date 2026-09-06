#!/usr/bin/env python3
"""Headless desktop/mobile captures for the Now Calendar view (CBICS-05, CBICS-10).

Renders `buildNowCalendarView`/`nowCalendarSwitchHTML` (site/now_calendar.mjs,
site/now_calendar_switch.mjs) directly with the shared compact month
renderer -- the same production modules the Now surface mounts between Cards
and its horizon-bounded population -- against a qualifying dense bundle and a
sparse bundle. No public route or worker is mounted; like the sibling
`capture_land_project_connected_calendar.py` and
`capture_exam_calendar_evidence.py` harnesses, this is a direct component
capture, so it never depends on the real wall clock.

    python3 tools/capture_now_calendar_evidence.py
    python3 tools/capture_now_calendar_evidence.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "now-calendar-view"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = ((390, 844), (1440, 900))
TODAY = "2026-06-01"
ROUTE = "component-harness:now-calendar-view"

# Each specimen names the acceptance criterion it exercises. Identities mirror
# test/fixtures/calendar_parity_matrix.mjs's NOW_FIXTURES so the browser
# evidence and the pure parity suite describe the same population.
SPECIMENS = (
    ("dense-calendar", "A1: a scoped dated act-by deadline and happening-soon event calendarize with the Calendar view pressed"),
    ("sparse-cards", "A4: a below-density bundle falls back to Cards with a plain-language note, no empty calendar chrome"),
)

RENDER_JS = r"""
import { buildNowCalendarView, nowCalendarOccurrences } from "./site/now_calendar.mjs";
import { nowCalendarSwitchHTML } from "./site/now_calendar_switch.mjs";
import { renderCompactMonth } from "./site/compact_calendar.mjs";

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function item({ id, day, route, title, domain = "money" }) {
  return { id, title, route, domain, cancelled: false, time: { day, value: day, precision: "date", basis: "publisher_record", verified: true } };
}

const denseSurface = {
  act_by: {
    dated: [
      item({ id: "money:parity-bid:2026-06-08", day: "2026-06-08", route: "/notices/parity-bid", title: "Bridge inspection services due" }),
      item({ id: "rules:parity-comment:2026-06-15", day: "2026-06-15", route: "/notices/parity-comment", title: "Comment period closes", domain: "rules" }),
    ],
    open_without_date: [{ id: "money:parity-rolling", title: "Continuously open solicitation", route: "/notices/parity-rolling" }],
  },
  happening_soon: {
    items: [item({ id: "meeting:parity-board:2026-06-22", day: "2026-06-22", route: "/meetings/parity-board", title: "Full board meeting", domain: "meetings" })],
  },
};

const sparseSurface = {
  act_by: { dated: [item({ id: "money:parity-only:2026-06-08", day: "2026-06-08", route: "/notices/parity-only", title: "One dated act-by item" })], open_without_date: [] },
  happening_soon: { items: [] },
};

// The resident-facing English strings the real Now page's translation
// function resolves these keys to (site/now_view.mjs); this harness renders
// components directly, without the page's i18n wiring, so it supplies the
// same English copy explicitly rather than showing raw translation keys.
const EN_LABELS = {
  now_calview_cards: "Cards",
  now_calview_calendar: "Calendar",
};
const t = (key) => EN_LABELS[key] || key;

const today = process.argv[1];
const specimens = { "dense-calendar": denseSurface, "sparse-cards": sparseSurface };
const panels = {};
for (const [slug, surface] of Object.entries(specimens)) {
  const view = buildNowCalendarView(surface, { today });
  const switchHtml = nowCalendarSwitchHTML({ view: view.render ? "calendar" : "list", currentHash: "#now", t });
  const calendarHtml = view.render ? renderCompactMonth(view, { esc }) : "";
  panels[slug] = {
    render: view.render,
    reason: view.render ? null : view.reason,
    occurrence_count: nowCalendarOccurrences(surface).length,
    html: `<div class="now-calview-switch">${switchHtml}</div>${calendarHtml || '<p class="now-calview-fallback-note">Showing Cards -- this bundle does not have enough dated items yet for a calendar view.</p>'}`,
  };
}
process.stdout.write(JSON.stringify(panels));
"""


def panel_css() -> str:
    compact = (ROOT / "site" / "compact_calendar.css").read_text(encoding="utf-8")
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
        ".now-calview-switch{display:flex;gap:8px;margin-bottom:12px}"
        ".now-calview-fallback-note{color:var(--muted);font-size:14px}"
        "#host{min-height:24px;outline:1px dashed var(--rule)}"
    )
    return root + compact


def render_panels() -> dict[str, dict]:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", RENDER_JS, "--", TODAY],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def page_html(panel_html: str) -> str:
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<title>Now calendar-view harness</title>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<style>{panel_css()}</style></head>"
        f"<body><main><div id='host'>{panel_html}</div></main></body></html>"
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
        for slug, assertion in SPECIMENS:
            panel = panels.get(slug)
            if panel is None:
                raise SystemExit(f"render script produced no panel for {slug}")
            if slug == "dense-calendar" and not panel["render"]:
                raise SystemExit("dense-calendar specimen unexpectedly fell back to Cards")
            if slug == "sparse-cards" and panel["render"]:
                raise SystemExit("sparse-cards specimen unexpectedly rendered a month view")
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(page_html(panel["html"]), wait_until="domcontentloaded")
                host = page.locator("#host")
                host.wait_for(state="attached")
                axe_result = run_axe(page)
                dest = OUT / f"{slug}-{width}.png"
                host.screenshot(path=str(dest), animations="disabled")
                data = dest.read_bytes()
                files.append({
                    "name": dest.name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "route": ROUTE,
                    "viewport": [width, height],
                    "revision": revision,
                    "specimen": slug,
                    "occurrence_vintage_state": TODAY,
                    "renders": panel["render"],
                    "occurrence_count": panel["occurrence_count"],
                    "assertion": assertion,
                    "axe": axe_result,
                })
                page.close()
        browser.close()
    manifest = {
        "schema_version": 1,
        "feature": "now-calendar-view",
        "card": "cityscroll-engineering/cross-surface-parity-launch-quality",
        "route": ROUTE,
        "revision": revision,
        "today": TODAY,
        "files": files,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def check() -> int:
    manifest_path = OUT / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"missing {manifest_path.relative_to(ROOT)}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {f"{slug}-{width}.png" for slug, _ in SPECIMENS for width, _ in VIEWPORTS}
    found = {row["name"] for row in manifest.get("files") or []}
    missing = expected - found
    if missing:
        raise SystemExit(f"missing captures: {sorted(missing)}")
    for row in manifest["files"]:
        path = OUT / row["name"]
        if not path.exists() or path.stat().st_size < 1000:
            raise SystemExit(f"empty or missing capture {row['name']}")
        if row["axe"] and row["axe"]["failing_violations"]:
            raise SystemExit(f"{row['name']} failed the axe gate: {row['axe']['failing_violations']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    capture()
    print("captured", len(SPECIMENS) * len(VIEWPORTS), "now calendar-view screenshots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
