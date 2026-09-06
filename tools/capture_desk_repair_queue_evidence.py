#!/usr/bin/env python3
"""Headless browser evidence for the Desk repair queue.

The contract tests prove the queue's data: identity, grouping, states,
verification, and the boundary it inherits. This script proves the part a
contract test cannot reach — that an operator can actually work the view. It
renders the real desk document from committed data, serves it, and at the two
reviewed widths (390px and 1440px) walks four journeys:

  - `desk-home`, the view the desk opens with, to show the repair queue joined
    the existing navigation instead of replacing it,
  - `repair-queue`, with every grouped row expanded, which is the detail journey
    the card asks for,
  - `repair-queue-filtered`, driven with real key presses through the shared
    search box and the state select, so keyboard filtering and focus are
    measured rather than assumed, and
  - `repair-queue-unavailable`, the ingestion-failure variant, which must render
    an explicit failure and must not render an all-clear.

Each capture records axe-core (vendored, no network), keyboard reachability and
visible focus, pointer-target size against the 24x24 CSS-pixel floor, horizontal
overflow at 100%, and horizontal overflow at 200% zoom clamped at the 320px
reflow floor. It also scans every rendered link for an owner-only or local
reference, because a queue row whose evidence link only opens on its author's
machine is not evidence anyone else can use.

Capture proof is the committed manifest: route, viewport, revision, data
vintage, assertion, and a sha256 per capture. Image binaries stay in the ignored
local path beside it and are never committed.

Run: python3 tools/capture_desk_repair_queue_evidence.py
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
OUT = ROOT / "docs" / "screenshots" / "desk-repair-queue"
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
# WCAG 2.5.8 (AA) minimum pointer-target size.
TARGET_FLOOR = 24

# Accessibility defects reproduced by this document that belong to markup this
# card does not own. Named per journey and per rule, never globally, so a NEW
# violation of the same rule anywhere else still fails.
PRE_EXISTING: dict[tuple[str, str], dict] = {
    # The topology graph declares role="img" and then gives each source node
    # role="button" and a tabindex, so the image contains focusable children.
    # That markup predates this view and belongs to the graph renderer; fixing
    # it changes the graph's rendered output, which is outside this card.
    ("desk-home", "nested-interactive"): {
        "owner": "tools/data_source_graph.mjs",
        "renderer": "renderGraphHtml",
        "target": "#sourceGraph",
        "note": "role=\"img\" topology graph containing focusable source nodes; predates the repair view",
    },
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FIXTURE_DIR), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def build_desk() -> dict:
    """Ask the producer for its own output, so the capture cannot drift from it."""
    script = """
import { readFileSync } from "node:fs";

import {
  HTML_OUTPUT,
  JSON_OUTPUT,
  ROOT,
  buildDataSourceGraph,
  communityBoardRepairObservations,
  generatedGraphFiles,
  inputManifest,
  renderGraphHtml,
} from "./tools/data_source_graph.mjs";
import { REPAIR_QUEUE_REGISTER_PATH } from "./tools/repair_queue.mjs";

const readJson = (path) => JSON.parse(readFileSync(`${ROOT}/${path}`, "utf8"));
const inputs = inputManifest();
const files = generatedGraphFiles({ inputs });
const graph = JSON.parse(files[JSON_OUTPUT]);
const registry = readJson("site/data/source_contracts.json");
const pass = communityBoardRepairObservations(registry);

// The same producer, told its inputs were unreadable. This is the failure the
// desk has to render honestly, built by the real code path rather than by
// hand-editing markup.
const unavailable = buildDataSourceGraph({
  registry,
  gapTaxonomy: readJson("site/data/gap_taxonomy.json"),
  warehouse: readJson("warehouse/datasets.v0.json"),
  wranglerText: readFileSync(`${ROOT}/worker/wrangler.toml`, "utf8"),
  workerText: readFileSync(`${ROOT}/worker/src/worker.mjs`, "utf8"),
  externalAwardText: readFileSync(`${ROOT}/worker/src/external_award.mjs`, "utf8"),
  receipts: new Map(),
  healthObservations: readJson("site/data/source_health_observations.json"),
  repairObservations: [],
  repairRegister: readJson(REPAIR_QUEUE_REGISTER_PATH),
  repairIngestion: {
    available: false,
    reason: "the committed source receipts the repair projection reads were not available",
    missing_inputs: ["site/data/community_board_meeting_index.json"],
  },
  inputs,
});

process.stdout.write(JSON.stringify({
  html: files[HTML_OUTPUT],
  unavailable_html: renderGraphHtml(unavailable),
  source_vintage: graph.repair_queue.source_vintage,
  observation_count: graph.repair_observations.observations.length,
  issue_count: graph.repair_queue.issue_count,
  open_work_count: graph.repair_queue.open_work_count,
  issue_keys: graph.repair_queue.issues.map((issue) => issue.issue_key),
  states: graph.repair_queue.issues.map((issue) => issue.state),
  filter_term: graph.repair_queue.issues[0]?.identity?.adapter || "",
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
        "failing_violations": [
            {
                "id": v["id"],
                "impact": v.get("impact"),
                "targets": [str(node.get("target")) for node in v.get("nodes", [])][:4],
            }
            for v in gate
        ],
        "passes": len(gate) == 0,
    }


def check_keyboard_focus(page) -> dict:
    """Walk the visible view with real Tab presses so :focus-visible is honest."""
    expected = page.evaluate("""() => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        if (node.closest('details:not([open]) > *:not(summary)')) return false;
        return rect.width > 0 && rect.height > 0 && node.offsetParent !== null;
      };
      const controls = [...document.querySelectorAll('a[href], button, input, select, summary, [tabindex]:not([tabindex="-1"])')]
        .filter(visible);
      controls.forEach((control, index) => control.setAttribute('data-kbd-index', String(index)));
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
      return controls.length;
    }""")
    reached: set[int] = set()
    without_indicator: list[str] = []
    for _ in range(expected * 2 + 5):
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
    missed = page.evaluate(
        "(reached) => [...document.querySelectorAll('[data-kbd-index]')]"
        ".filter((node) => !reached.includes(Number(node.getAttribute('data-kbd-index'))))"
        ".map((node) => node.outerHTML.slice(0, 80))",
        sorted(reached),
    )
    return {
        "controls": expected,
        "reached_by_tab": len(reached),
        "unreachable": missed,
        "without_focus_indicator": without_indicator,
    }


def check_touch_targets(page, floor: int) -> dict:
    return page.evaluate("""(floor) => {
      const controls = [...document.querySelectorAll('a[href], button, input, select, summary')]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          if (node.closest('details:not([open]) > *:not(summary)')) return false;
          return rect.width > 0 && rect.height > 0 && node.offsetParent !== null;
        });
      const undersized = controls
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width < floor || rect.height < floor)
        .map(({ node, rect }) => `${node.tagName.toLowerCase()}#${node.id || ''}.${String(node.className || '').split(/\\s+/)[0]} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      return { floor, measured: controls.length, undersized: [...new Set(undersized)].slice(0, 8) };
    }""", floor)


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


def check_private_links(page) -> dict:
    """A queue row whose link only opens on its author's machine is not evidence."""
    return page.evaluate("""() => {
      const markers = ['backstage' + '://', 'file://', '/Users/', '/var/folders/', '/private/tmp', 'http://localhost', '127.0.0.1'];
      const hrefs = [...document.querySelectorAll('a[href]')].map((node) => node.getAttribute('href'));
      return {
        links: hrefs.length,
        private_links: hrefs.filter((href) => markers.some((marker) => href.includes(marker))),
        non_https_links: hrefs.filter((href) => !/^https:\\/\\//.test(href)),
      };
    }""")


def journey_state(page, name: str, filter_term: str) -> dict:
    """Drive the desk into the state this capture is about, with real input."""
    if name == "desk-home":
        return page.evaluate("""() => ({
          view: document.getElementById('graphView').hidden ? 'hidden' : 'graph',
          repair_hidden: document.getElementById('repairView').hidden,
          pressed: [...document.querySelectorAll('.toggle button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.id),
        })""")
    page.click("#repairToggle")
    if name == "repair-queue-filtered":
        page.click("#search")
        page.keyboard.type(filter_term)
        page.keyboard.press("Tab")
        visible_after_text = page.evaluate(
            "() => [...document.querySelectorAll('[data-repair-issue]')].filter((row) => !row.hidden).length",
        )
        page.select_option("#repairState", "repair-candidate")
        return {
            "view": "repair",
            "filter_term": filter_term,
            "issues_total": page.evaluate("() => document.querySelectorAll('[data-repair-issue]').length"),
            "visible_after_text_filter": visible_after_text,
            "visible_after_state_filter": page.evaluate(
                "() => [...document.querySelectorAll('[data-repair-issue]')].filter((row) => !row.hidden).length",
            ),
        }
    expanded = page.evaluate("""() => {
      const rows = [...document.querySelectorAll('details.queue-issue')];
      rows.forEach((row) => { row.open = true; });
      return {
        view: 'repair',
        groups: rows.length,
        expanded: rows.filter((row) => row.open).length,
        scope_rows: document.querySelectorAll('.queue-body tbody tr').length,
        unavailable_notice: document.querySelectorAll('.queue-unavailable').length,
        state_pills: [...document.querySelectorAll('.queue-count')].map((node) => node.textContent.trim()),
      };
    }""")
    return expanded


def main() -> None:
    desk = build_desk()
    revision = git_revision()
    data_vintage = (
        "committed source-contract ledger, source-health observations and Community Board source "
        "receipts (site/data/source_contracts.json, site/data/source_health_observations.json, "
        "site/data/community_board_meeting_index.json, "
        "site/data/non_council_outcome_sources/board_source_inventory.json) plus the reviewed register "
        f"data/repair-queue-register.v1.json, at index vintage {desk['source_vintage']}; "
        "no network, publisher, or production read at any point"
    )

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for stale in FIXTURE_DIR.glob("*.html"):
        stale.unlink()
    (FIXTURE_DIR / "desk.html").write_text(desk["html"], encoding="utf-8")
    (FIXTURE_DIR / "desk-unavailable.html").write_text(desk["unavailable_html"], encoding="utf-8")

    journeys = [
        ("desk-home", "desk.html", "the desk opens on the graph view it opened on before the queue existed"),
        ("repair-queue", "desk.html", "every grouped row expands to its observation detail"),
        ("repair-queue-filtered", "desk.html", "the shared search box and the state select filter grouped rows from the keyboard"),
        ("repair-queue-unavailable", "desk-unavailable.html", "a failed ingestion renders an explicit failure, never an all-clear"),
    ]

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    captures: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for name, document, intent in journeys:
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                route = f"/{document}"
                page.goto(f"{base}{route}", wait_until="networkidle")

                state = journey_state(page, name, desk["filter_term"])
                axe_result = run_axe(page)
                keyboard = check_keyboard_focus(page)
                targets = check_touch_targets(page, TARGET_FLOOR)
                overflow = check_overflow(page, width)
                links = check_private_links(page)

                zoom_width = max(REFLOW_FLOOR, width // ZOOM)
                zoom_height = height // ZOOM
                page.set_viewport_size({"width": zoom_width, "height": zoom_height})
                zoom_overflow = check_overflow(page, zoom_width)
                page.set_viewport_size({"width": width, "height": height})

                shot = OUT / f"{name}-{width}.png"
                page.screenshot(path=str(shot), full_page=True)
                digest = hashlib.sha256(shot.read_bytes()).hexdigest()

                keyboard_ok = not keyboard["unreachable"] and not keyboard["without_focus_indicator"]
                assertion = (
                    f"{name}: {intent}; "
                    f"axe_passes={axe_result['passes']} "
                    f"keyboard_reachable_and_focus_visible={keyboard_ok} "
                    f"touch_targets_at_least_{TARGET_FLOOR}px={not targets['undersized']} "
                    f"no_private_or_local_link={not links['private_links']} "
                    f"no_horizontal_overflow={not overflow['horizontal_overflow']} "
                    f"no_horizontal_overflow_at_{ZOOM * 100}_percent_zoom={not zoom_overflow['horizontal_overflow']}"
                )
                captures.append({
                    "journey": name,
                    "intent": intent,
                    "owning_file": "tools/repair_queue.mjs",
                    "owning_renderer": "renderRepairQueueSection",
                    "route": route,
                    "viewport": {"width": width, "height": height},
                    "zoom_viewport": {"width": zoom_width, "height": zoom_height, "zoom_percent": ZOOM * 100},
                    "revision": revision,
                    "data_vintage": data_vintage,
                    "journey_state": state,
                    "axe": axe_result,
                    "keyboard": keyboard,
                    "touch_targets": targets,
                    "overflow": overflow,
                    "zoom_overflow": zoom_overflow,
                    "links": links,
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
            if (capture["journey"], violation["id"]) not in PRE_EXISTING
        ]

    def journey_holds(capture: dict) -> bool:
        state = capture["journey_state"]
        if capture["journey"] == "desk-home":
            return state["view"] == "graph" and state["repair_hidden"] and state["pressed"] == ["graphToggle"]
        if capture["journey"] == "repair-queue":
            return (
                state["groups"] > 0
                and state["expanded"] == state["groups"]
                and state["scope_rows"] > state["groups"]
                and state["unavailable_notice"] == 0
            )
        if capture["journey"] == "repair-queue-filtered":
            return (
                state["issues_total"] > 0
                and 0 < state["visible_after_text_filter"] < state["issues_total"]
                and 0 < state["visible_after_state_filter"] <= state["visible_after_text_filter"]
            )
        return state["unavailable_notice"] == 1 and state["groups"] == 0

    def holds(capture: dict) -> bool:
        return (
            journey_holds(capture)
            and not capture["keyboard"]["unreachable"]
            and not capture["keyboard"]["without_focus_indicator"]
            and not capture["touch_targets"]["undersized"]
            and not capture["links"]["private_links"]
            and not capture["overflow"]["horizontal_overflow"]
            and not capture["zoom_overflow"]["horizontal_overflow"]
            and not scoped_axe(capture)
        )

    for capture in captures:
        capture["axe_scoped_failing_violations"] = scoped_axe(capture)

    inherited = [
        {
            "journey": capture["journey"],
            "viewport": capture["viewport"],
            "rule": violation["id"],
            "impact": violation["impact"],
            **PRE_EXISTING[(capture["journey"], violation["id"])],
        }
        for capture in captures
        for violation in capture["axe"]["failing_violations"]
        if (capture["journey"], violation["id"]) in PRE_EXISTING
    ]
    failures = [capture for capture in captures if not holds(capture)]
    receipt = {
        "schema": "cityscroll.desk_repair_queue_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "data_vintage": data_vintage,
        "viewports": [{"width": width, "height": height} for width, height in VIEWPORTS],
        "zoom_percent": ZOOM * 100,
        "touch_target_floor_px": TARGET_FLOOR,
        "capture_convention": (
            "the manifest is the committed proof; rendered image binaries stay under "
            "the ignored local path named per capture and are never committed"
        ),
        "observations_projected": desk["observation_count"],
        "issues_grouped": desk["issue_count"],
        "open_repairs": desk["open_work_count"],
        "issue_states": desk["states"],
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
            print(f"FAIL {capture['journey']} @{capture['viewport']['width']}px: {capture['assertion']}", file=sys.stderr)
        sys.exit(1)
    print(
        f"desk repair-queue evidence: {len(captures)} captures passed at 390px and 1440px, "
        f"including {ZOOM * 100}% zoom and the {TARGET_FLOOR}px pointer-target floor"
    )
    for item in inherited:
        print(
            f"note: pre-existing {item['impact']} '{item['rule']}' in {item['owner']} "
            f"reproduced by journey {item['journey']} @{item['viewport']['width']}px",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
