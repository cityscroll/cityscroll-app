#!/usr/bin/env python3
"""Headless browser evidence that the private repair projection stays private.

`tools/repair_observations.mjs` derives operator repair records from the same
committed source receipts that the Community Board resident document renders.
The contract tests already prove the two projections are disjoint as data. This
script proves it where a reader actually meets the page: it renders the affected
resident projections, serves them, and at the two reviewed widths (390px and
1440px) checks

  - that no repair-observation fingerprint, condition, disposition, schema, or
    operator-only field name appears anywhere in the live DOM, in visible text,
    or in an accessible name,
  - axe-core (vendored, no network) for accessibility violations,
  - that every interactive control is keyboard reachable and shows a visible
    focus indicator,
  - that nothing overflows the viewport horizontally at 100%, and
  - that nothing overflows at 200% zoom, which in CSS pixels is the same layout
    in half the width, clamped at the 320px reflow floor.

It also drives a NEGATIVE fixture: the operator record rendered into the
document as a diagnostic block. That fixture must be caught, and must remain
ordinary non-crashing markup in a real engine, so a pass on the positives means
the check can actually see a leak rather than seeing nothing.

Capture proof is the committed manifest: route, viewport, revision, data
vintage, assertion, and a sha256 per capture. Image binaries stay in the ignored
local path beside it and are never committed.

Run: python3 tools/capture_repair_observation_boundary_evidence.py
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "repair-observation-boundary"
FIXTURE_DIR = OUT / "fixtures"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
ZOOM = 2
# WCAG 1.4.10 sets the reflow floor at 320 CSS pixels wide. Doubling zoom halves
# the viewport in CSS pixels, so 1440px becomes 720px; 390px would become 195px,
# which is narrower than any width the standard asks content to reflow into, so
# the zoomed width is clamped to the floor rather than invented below it.
REFLOW_FLOOR = 320

# Accessibility defects reproduced by these fixtures that belong to markup this
# card does not own. Named per fixture and per rule, never globally, so a NEW
# violation of the same rule anywhere else still fails.
PRE_EXISTING: dict[tuple[str, str], dict] = {}

SITE_STYLESHEETS = ["/brand.css", "/civic-documents.css", "/local_constellation.css"]

DOCUMENT_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
{styles}
</head><body><main id="main">{body}</main></body></html>
"""


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FIXTURE_DIR), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def build_corpus() -> dict:
    """Ask the contract and the renderer for their own output, so nothing drifts."""
    script = """
import { readFileSync } from "node:fs";

import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "./site/community_board_constellation.mjs";
import { communityBoardRepairObservations } from "./tools/data_source_graph.mjs";
import { repairObservationLeakFindings, repairObservationSet } from "./tools/repair_observations.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const registry = readJson("site/data/source_contracts.json");
const { observations, observedAt, sourceVintage } = communityBoardRepairObservations(registry);
const set = repairObservationSet(observations, { observedAt, sourceVintage });
const sources = {
  sourceRegistry: readJson("site/data/non_council_outcome_sources/source_registry.json"),
  sourceInventory: readJson("site/data/non_council_outcome_sources/board_source_inventory.json"),
  scorecard: readJson("site/data/community_board_minutes_scorecard.json"),
  geography: readJson("site/data/community_board_geography_lookup.json"),
};

const positives = ["manhattan-cb-03", "brooklyn-cb-02", "manhattan-cb-06"].map((boardId) => {
  const html = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView(boardId, sources));
  return {
    id: `community-board-document:${boardId}`,
    polarity: "positive",
    file: "site/community_board_constellation.mjs",
    renderer: "renderCommunityBoardConstellationDocument",
    html,
    leaks: repairObservationLeakFindings(html, { label: boardId, observations }).length,
  };
});

// The regression this card exists to prevent: the operator record rendered back
// into the resident document.
const leaked = observations[0];
const negativeHtml = `<section class="node-section node-card"><h2>Source repair state</h2>`
  + `<ul class="node-record-list"><li class="node-record"><div class="node-record-main">`
  + `<strong>Upcoming meetings</strong></div><span class="muted node-muted">`
  + `${leaked.condition.id} · ${leaked.condition.disposition} · fingerprint ${leaked.fingerprint}`
  + ` · detail_code ${leaked.condition.detail_code}</span></li></ul></section>`;
const negatives = [{
  id: "negative:leaked-repair-observation",
  polarity: "negative",
  file: "site/community_board_constellation.mjs",
  renderer: "renderCommunityBoardConstellationDocument",
  html: negativeHtml,
  leaks: repairObservationLeakFindings(negativeHtml, { label: "negative", observations }).length,
}];

process.stdout.write(JSON.stringify({
  fixtures: [...positives, ...negatives],
  observation_markers: {
    fingerprints: observations.map((row) => row.fingerprint),
    conditions: set.conditions,
    dispositions: set.dispositions,
  },
  observation_count: observations.length,
  source_vintage: sourceVintage,
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


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


def check_keyboard_focus(page) -> dict:
    """Walk the document with real Tab presses so :focus-visible is honest."""
    expected = page.evaluate("""() => {
      document.querySelectorAll('details').forEach((node) => { node.open = true; });
      const controls = [...document.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')];
      controls.forEach((control, index) => control.setAttribute('data-kbd-index', String(index)));
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
      return controls.length;
    }""")
    reached: set[int] = set()
    without_indicator: list[str] = []
    for _ in range(expected + 3):
        if len(reached) >= expected:
            break
        page.keyboard.press("Tab")
        stop = page.evaluate("""() => {
          const node = document.activeElement;
          if (!node || !node.hasAttribute?.('data-kbd-index')) return null;
          const style = getComputedStyle(node);
          const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth || '0') > 0;
          const shadow = Boolean(style.boxShadow) && style.boxShadow !== 'none';
          return {
            index: Number(node.getAttribute('data-kbd-index')),
            markup: node.outerHTML.slice(0, 80),
            focus_visible: node.matches(':focus-visible'),
            indicator: outline || shadow,
          };
        }""")
        if not stop or stop["index"] in reached:
            continue
        reached.add(stop["index"])
        if not (stop["indicator"] and stop["focus_visible"]):
            without_indicator.append(stop["markup"])
    missed = expected - len(reached)
    return {
        "controls": expected,
        "reached_by_tab": len(reached),
        "unreachable": [f"{missed} control(s) never took keyboard focus"] if missed else [],
        "without_focus_indicator": without_indicator,
    }


def check_overflow(page, width: int) -> dict:
    return page.evaluate("""(width) => {
      const doc = document.documentElement;
      const overflowing = [...document.querySelectorAll('*')]
        .filter((node) => node.getBoundingClientRect().right > width + 1)
        .map((node) => node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).split(/\\s+/)[0] : ''));
      return {
        scroll_width: doc.scrollWidth,
        viewport_width: width,
        horizontal_overflow: doc.scrollWidth > width + 1,
        overflowing_nodes: [...new Set(overflowing)].slice(0, 8),
      };
    }""", width)


def check_leakage(page, markers: dict) -> dict:
    """Scan the live DOM, the visible text, and every accessible name.

    The DOM scan covers the machine channel too: the document embeds a JSON
    payload for machine consumers, and an operator record reaching that island
    would be just as much a leak as one printed on the page.
    """
    return page.evaluate("""(markers) => {
      const all = [
        ...markers.fingerprints,
        ...markers.conditions,
        ...markers.dispositions,
        'cityscroll.repair_observation.v1',
        'cityscroll.repair_observation_set.v1',
        'repair_observations',
        'detail_code',
        'code_revision',
        'first_observed_at',
        'last_observed_at',
        'observation_count',
        'evidence_locator',
      ];
      const dom = document.documentElement.outerHTML;
      const visible = document.body.innerText.replace(/\\s+/g, ' ');
      const names = [...document.querySelectorAll('[aria-label], [alt], [title]')]
        .map((node) => node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title'))
        .filter(Boolean).join(' ');
      const hit = (haystack) => all.filter((token) => haystack.includes(token));
      return {
        in_dom: hit(dom),
        in_visible_text: hit(visible),
        in_accessible_names: hit(names),
        markers_checked: all.length,
      };
    }""", markers)


def main() -> None:
    corpus = build_corpus()
    fixtures = corpus["fixtures"]
    markers = corpus["observation_markers"]
    revision = git_revision()
    data_vintage = (
        "committed Community Board sources: site/data/community_board_meeting_index.json, "
        "site/data/non_council_outcome_sources/*.json, site/data/community_board_minutes_scorecard.json "
        "and site/data/community_board_geography_lookup.json, at index vintage "
        f"{corpus['source_vintage']}; no network, publisher, or production read at any point"
    )

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for stale in FIXTURE_DIR.glob("*.html"):
        stale.unlink()

    styles = "\n".join(f'<link rel="stylesheet" href="{href}">' for href in SITE_STYLESHEETS)
    for fixture in fixtures:
        slug = fixture["id"].replace(":", "--").replace("/", "-")
        fixture["slug"] = slug
        (FIXTURE_DIR / f"{slug}.html").write_text(
            DOCUMENT_TEMPLATE.format(title=fixture["id"], styles=styles, body=fixture["html"]),
            encoding="utf-8",
        )
    for href in SITE_STYLESHEETS:
        source = ROOT / "site" / href.lstrip("/")
        if source.exists():
            (FIXTURE_DIR / href.lstrip("/")).write_text(source.read_text(encoding="utf-8"), encoding="utf-8")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    captures: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for fixture in fixtures:
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                route = f"/{fixture['slug']}.html"
                page.goto(f"{base}{route}", wait_until="networkidle")

                axe_result = run_axe(page)
                keyboard = check_keyboard_focus(page)
                overflow = check_overflow(page, width)
                leakage = check_leakage(page, markers)

                # 200% zoom: the same layout in half the CSS pixels, which is
                # what a browser's zoom control produces.
                zoom_width = max(REFLOW_FLOOR, width // ZOOM)
                zoom_height = height // ZOOM
                page.set_viewport_size({"width": zoom_width, "height": zoom_height})
                zoom_overflow = check_overflow(page, zoom_width)
                zoom_leakage = check_leakage(page, markers)
                page.set_viewport_size({"width": width, "height": height})

                shot = OUT / f"{fixture['slug']}-{width}.png"
                page.screenshot(path=str(shot), full_page=True)
                digest = hashlib.sha256(shot.read_bytes()).hexdigest()

                keyboard_ok = not keyboard["unreachable"] and not keyboard["without_focus_indicator"]
                leak_count = len(leakage["in_dom"]) + len(zoom_leakage["in_dom"])
                expects_leaks = fixture["polarity"] == "negative"
                assertion = (
                    f"{fixture['polarity']} fixture: repair_observation_markers_in_dom={leak_count} "
                    f"(expected {'>0' if expects_leaks else '0'}) "
                    f"axe_passes={axe_result['passes']} "
                    f"keyboard_reachable_and_focus_visible={keyboard_ok} "
                    f"no_horizontal_overflow={not overflow['horizontal_overflow']} "
                    f"no_horizontal_overflow_at_{ZOOM * 100}_percent_zoom={not zoom_overflow['horizontal_overflow']}"
                )
                captures.append({
                    "fixture": fixture["id"],
                    "polarity": fixture["polarity"],
                    "owning_file": fixture["file"],
                    "owning_renderer": fixture["renderer"],
                    "route": route,
                    "viewport": {"width": width, "height": height},
                    "zoom_viewport": {"width": zoom_width, "height": zoom_height, "zoom_percent": ZOOM * 100},
                    "revision": revision,
                    "data_vintage": data_vintage,
                    "axe": axe_result,
                    "keyboard": keyboard,
                    "overflow": overflow,
                    "zoom_overflow": zoom_overflow,
                    "repair_observation_leakage": leakage,
                    "repair_observation_leakage_at_zoom": zoom_leakage,
                    "contract_leak_findings": fixture["leaks"],
                    "assertion": assertion,
                    # The image itself stays local; this digest is the committed proof.
                    "screenshot_local_path": str(shot.relative_to(ROOT)),
                    "screenshot_sha256": digest,
                })
                page.close()
                context.close()
        browser.close()
    server.shutdown()

    def scoped_axe(capture: dict) -> list[dict]:
        return [
            violation for violation in capture["axe"]["failing_violations"]
            if (capture["fixture"], violation["id"]) not in PRE_EXISTING
        ]

    def holds(capture: dict) -> bool:
        leaked = (
            capture["repair_observation_leakage"]["in_dom"]
            or capture["repair_observation_leakage_at_zoom"]["in_dom"]
            or capture["repair_observation_leakage"]["in_visible_text"]
            or capture["repair_observation_leakage"]["in_accessible_names"]
        )
        if capture["polarity"] == "negative":
            # A rejected fixture still has to be ordinary markup a browser can
            # render, but its layout is not held to the positive standard: the
            # horizontal overflow it records is a CONSEQUENCE of printing a
            # 64-character machine identifier into resident copy, and is part of
            # what the leak costs rather than a separate defect to fix.
            return (
                not scoped_axe(capture)
                and bool(leaked)
                and capture["contract_leak_findings"] > 0
            )
        return (
            not capture["keyboard"]["unreachable"]
            and not capture["keyboard"]["without_focus_indicator"]
            and not capture["overflow"]["horizontal_overflow"]
            and not capture["zoom_overflow"]["horizontal_overflow"]
            and not scoped_axe(capture)
            and not leaked
            and capture["contract_leak_findings"] == 0
        )

    for capture in captures:
        capture["axe_scoped_failing_violations"] = scoped_axe(capture)

    inherited = [
        {
            "fixture": capture["fixture"],
            "viewport": capture["viewport"],
            "rule": violation["id"],
            "impact": violation["impact"],
            **PRE_EXISTING[(capture["fixture"], violation["id"])],
        }
        for capture in captures
        for violation in capture["axe"]["failing_violations"]
        if (capture["fixture"], violation["id"]) in PRE_EXISTING
    ]
    failures = [capture for capture in captures if not holds(capture)]
    receipt = {
        "schema": "cityscroll.repair_observation_boundary_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "data_vintage": data_vintage,
        "viewports": [{"width": width, "height": height} for width, height in VIEWPORTS],
        "zoom_percent": ZOOM * 100,
        "capture_convention": (
            "the manifest is the committed proof; rendered image binaries stay under "
            "the ignored local path named per capture and are never committed"
        ),
        "observations_projected": corpus["observation_count"],
        "leak_markers_checked": captures[0]["repair_observation_leakage"]["markers_checked"] if captures else 0,
        "inherited_accessibility_findings": inherited,
        "inherited_note": (
            "these are real, reproducible defects in markup owned by other cards; "
            "this run reports them and does not gate on them, because fixing them "
            "changes rendered output outside this card's scope"
        ),
        "captures_passing": len(captures) - len(failures),
        "captures_total": len(captures),
        "captures": captures,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(captures)} captures under {OUT.relative_to(ROOT)}")
    if failures:
        for capture in failures:
            print(f"FAIL {capture['fixture']} @{capture['viewport']['width']}px: {capture['assertion']}", file=sys.stderr)
        sys.exit(1)
    print(
        f"repair-observation boundary evidence: {len(captures)} captures passed at 390px and 1440px, "
        f"including {ZOOM * 100}% zoom"
    )
    for item in inherited:
        print(
            f"note: pre-existing {item['impact']} '{item['rule']}' in {item['owner']} "
            f"({item['renderer']}) reproduced by fixture {item['fixture']} @{item['viewport']['width']}px",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
