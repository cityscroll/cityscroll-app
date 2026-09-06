#!/usr/bin/env python3
"""Headless desktop/mobile captures for the Land "Connected dates" panel (CBICS-06).

Renders `landProjectConnectedCalendarHTML` (site/land_project_connected_calendar.mjs)
directly — the same production module `site/app/land.mjs` mounts between project
connections and the long phase spine — against four synthetic specimens covering
the required states: a dense/qualifying accepted bundle, a sparse accepted bundle,
a dense bundle with a rejected/held relation mixed in, and unavailable/partial
project connections. No public route or worker is mounted; like the sibling
`capture_land_authority_panel.py` and `capture_compact_calendar_evidence.py`
harnesses, this is a direct component capture.

    python3 tools/capture_land_project_connected_calendar.py
    python3 tools/capture_land_project_connected_calendar.py --check
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
OUT = ROOT / "docs" / "screenshots" / "land-project-connected-calendar"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = ((390, 844), (1440, 900))
TODAY = "2026-03-15"
ROUTE = "component-harness:land-project-connected-calendar"

# Each specimen names the acceptance criterion it exercises. Dates mirror
# test/land_project_calendar.test.mjs so the browser evidence and the pure
# suite describe the same population.
SPECIMENS = (
    ("dense-qualifying", "A1/A2: an accepted, mixed past/future bundle dense enough to render"),
    ("sparse", "the density rule holds a thin accepted bundle to no month view"),
    ("rejected-relation", "A5: a held/rejected relation stays out even inside a qualifying month"),
    ("partial-unavailable", "A6: unavailable project connections mount no connected-calendar feed"),
)

RENDER_JS = r"""
import { landProjectConnectedCalendarHTML } from "./site/land_project_connected_calendar.mjs";

const PROJECT_REF = "project:2026M0001";
const CALENDAR_SOURCE = "https://cityscroll.org/connectors/project-2026M0001";
const SOURCE_URL = "https://records.example/source/2026-03";

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

const acceptedHearing = {
  relation: "project_hearing_decision",
  confidence: "strong",
  calendar_record: {
    object_ref: "notice:2026M0001-hearing",
    title: "Commission public hearing",
    event_date: "2026-03-18T19:00:00-04:00",
    canonical_url: "https://cityscroll.org/notices/2026m0001-hearing",
    source: { system: "city_record", record_id: "2026M0001-hearing", url: SOURCE_URL },
    status: "scheduled",
  },
};

const rejectedHearing = {
  relation: "project_proceeding_held",
  state: "held",
  calendar_record: {
    object_ref: "notice:2026M0001-held",
    title: "Dropped hearing",
    event_date: "2026-04-01T19:00:00-04:00",
    canonical_url: "https://cityscroll.org/notices/2026m0001-held",
    source: { system: "city_record", record_id: "2026M0001-held", url: SOURCE_URL },
  },
};

function record({ status = "bounded", items = [acceptedHearing], roots = [] } = {}) {
  return {
    project_id: "2026M0001",
    project_name: "Example project",
    project_ref: PROJECT_REF,
    project_calendar_sources: [
      {
        relation: "project_process",
        object_ref: "project:2026M0001:calendar-root",
        title: "Project filing",
        event_date: "2026-03-05T09:00:00-04:00",
        canonical_url: "https://cityscroll.org/projects/2026M0001",
        source: { system: "city_record", record_id: "2026M0001", url: CALENDAR_SOURCE },
      },
      ...roots,
    ],
    project_connections: {
      status,
      project_ref: PROJECT_REF,
      groups: [{ id: "project-connections", status: "matched", items }],
    },
  };
}

const denseRoots = [
  {
    relation: "project_process",
    object_ref: "project:2026M0001:milestone:certification",
    title: "Certification",
    event_date: "2026-03-10T09:00:00-04:00",
    canonical_url: "https://cityscroll.org/projects/2026M0001",
    source: { system: "zap-api-outcomes", record_id: "certification", url: CALENDAR_SOURCE },
    provenance: { basis: "publisher_record" },
  },
  {
    relation: "project_disposition",
    object_ref: "project:2026M0001:vote",
    title: "CPC vote",
    event_date: "2026-03-25T10:00:00-04:00",
    canonical_url: "https://cityscroll.org/projects/2026M0001",
    source: { system: "zap-api-outcomes", record_id: "vote", url: CALENDAR_SOURCE },
    provenance: { basis: "publisher_record" },
  },
];

const specimens = {
  "dense-qualifying": record({ roots: denseRoots, items: [acceptedHearing] }),
  "sparse": record({ items: [acceptedHearing] }),
  "rejected-relation": record({ roots: denseRoots, items: [acceptedHearing, rejectedHearing] }),
  "partial-unavailable": record({ status: "partial", items: [acceptedHearing] }),
};

const today = process.argv[1];
const panels = {};
for (const [slug, rec] of Object.entries(specimens)) {
  panels[slug] = landProjectConnectedCalendarHTML(rec, { today, escape: esc });
}
process.stdout.write(JSON.stringify(panels));
"""


def panel_css() -> str:
    compact = (ROOT / "site" / "compact_calendar.css").read_text(encoding="utf-8")
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
        ".eicard{border:1px solid var(--rule);border-radius:12px;padding:12px;background:#fff}"
        ".chain-h{font-weight:600;margin-bottom:8px}"
        "#host{min-height:24px;outline:1px dashed var(--rule)}"
    )
    return root + compact


def render_panels() -> dict[str, str]:
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
        "<title>Land connected-calendar harness</title>"
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
            html = panels.get(slug)
            if html is None:
                raise SystemExit(f"render script produced no panel for {slug}")
            renders = bool(html.strip())
            if slug == "rejected-relation" and "Dropped hearing" in html:
                raise SystemExit("held/rejected relation leaked into rendered panel markup")
            if slug in ("sparse", "partial-unavailable") and renders:
                raise SystemExit(f"{slug} specimen unexpectedly rendered a month view")
            if slug == "dense-qualifying" and not renders:
                raise SystemExit("dense-qualifying specimen unexpectedly produced no month view")
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(page_html(html), wait_until="domcontentloaded")
                host = page.locator("#host")
                host.wait_for(state="attached")
                child_count = page.evaluate("document.getElementById('host').children.length")
                occurrence_days = page.evaluate(
                    "new Set([...document.querySelectorAll('.compact-month-occ-link')]"
                    ".map(a => a.closest('td.compact-month-day, li.compact-month-agenda-day')"
                    "?.querySelector(':scope > time')?.getAttribute('datetime'))).size"
                ) if renders else 0
                axe_result = run_axe(page) if renders else None
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
                    "renders": renders,
                    "host_child_count": child_count,
                    "occurrence_day_cells": occurrence_days,
                    "assertion": assertion,
                    "axe": axe_result,
                })
                page.close()
        browser.close()
    manifest = {
        "schema_version": 1,
        "feature": "land-project-connected-calendar",
        "card": "cityscroll-engineering/land-project-connected-dates",
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
        # A "renders: false" specimen (sparse, partial/unavailable) is deliberately a
        # near-empty capture proving no month view mounted -- only a rendering
        # specimen is held to a substantial-content floor.
        floor = 1000 if row["renders"] else 1
        if not path.exists() or path.stat().st_size < floor:
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
    print("captured", len(SPECIMENS) * len(VIEWPORTS), "land project connected-calendar screenshots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
