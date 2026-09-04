#!/usr/bin/env python3
"""Headless evidence capture for Community Board Month/List (CBICS-04).

Serves the real, statically built `/community-boards/<id>/` route (built by
`tools/build_community_board_constellation_documents.mjs` against the
committed Community Board data) at 390px and 1440px for three real boards
covering the reviewed states: a dense board (accepted proceedings dense
enough to qualify for Month), a sparse board (accepted proceedings present
but list-only), and a coverage-unavailable board (no accepted proceedings
observed). Runs the vendored axe-core accessibility gate on each capture and
writes a receipt naming the route, viewport, git revision, board admission
state, and the resulting assertion.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "community-board-calendar"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
CASES = [
    {
        "board": "manhattan-cb-06",
        "route": "/community-boards/manhattan-cb-06/",
        "state": "dense",
        "assertion_note": "accepted proceedings meet the density rule: Month and List both render",
    },
    {
        "board": "bronx-cb-11",
        "route": "/community-boards/bronx-cb-11/",
        "state": "sparse",
        "assertion_note": "accepted proceedings exist but stay below the density rule: list-only, no calendar chrome",
    },
    {
        "board": "bronx-cb-01",
        "route": "/community-boards/bronx-cb-01/",
        "state": "coverage_unavailable_or_no_scheduled_meetings",
        "assertion_note": "no accepted proceedings observed: list-only, distinct 'not yet established' coverage note, no calendar chrome",
    },
]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def run_axe(page, selector: str | None = None) -> dict:
    page.add_script_tag(path=str(AXE))
    target = "document" if selector is None else f"document.querySelector({selector!r})"
    result = page.evaluate(f"async () => await axe.run({target}, {{resultTypes:['violations']}})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
        "passes": len(gate) == 0,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"

    receipts = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for case in CASES:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(f"{base}{case['route']}", wait_until="domcontentloaded")
                page.wait_for_selector("main[data-node-document]", state="attached")
                has_switch = page.locator('[data-board-proceedings-view="1"]').count() > 0
                has_month_grid = page.locator(".compact-month-grid").count() > 0
                list_visible = (
                    page.locator('[data-board-proceedings-panel="list"]').is_visible()
                    if has_switch
                    else page.locator(".node-record-list").first.is_visible()
                )
                shot = OUT / f"{case['board']}-{case['state']}-{width}x{height}.png"
                page.screenshot(path=str(shot), full_page=True)
                # Full-page axe is informational: it also catches pre-existing
                # issues in unrelated sections (e.g. the Community Board money
                # card's <dl> structure) that this card does not own and must
                # not silently paper over by narrowing the gate. The scoped
                # pass over exactly the markup this card adds is what CBICS-04
                # is actually accountable for and is what gates this capture.
                page_axe = run_axe(page)
                feature_axe = run_axe(page, ".board-proceedings-view") if has_switch else None
                receipts.append({
                    "board": case["board"],
                    "route": case["route"],
                    "admission_state": case["state"],
                    "viewport": {"width": width, "height": height},
                    "has_month_list_switch": has_switch,
                    "has_month_grid": has_month_grid,
                    "list_visible_by_default": list_visible,
                    "screenshot": str(shot.relative_to(ROOT)),
                    "axe_full_page": page_axe,
                    "axe_board_proceedings_view": feature_axe,
                    "assertion": (
                        f"board={case['board']} state={case['state']} at {width}x{height}: "
                        f"switch_present={has_switch} month_grid_present={has_month_grid} "
                        f"list_visible_by_default={list_visible} "
                        f"({case['assertion_note']}) "
                        f"cbics04_markup_axe_passes={feature_axe['passes'] if feature_axe else 'n/a-no-switch'} "
                        f"full_page_axe_passes={page_axe['passes']}"
                    ),
                })
                page.close()

        # No-JS check: disable JavaScript entirely and confirm the List still
        # renders and is usable on the dense board (the CSS-only Month/List
        # switch and the List itself require no script to work).
        no_js_context = browser.new_context(java_script_enabled=False, viewport={"width": 1440, "height": 900})
        page = no_js_context.new_page()
        page.goto(f"{base}/community-boards/manhattan-cb-06/", wait_until="domcontentloaded")
        no_js_list_visible = page.locator('[data-board-proceedings-panel="list"]').is_visible()
        no_js_month_reachable = page.locator('label.board-proceedings-view-tab', has_text="Month").count() > 0
        shot = OUT / "manhattan-cb-06-no-js-1440x900.png"
        page.screenshot(path=str(shot), full_page=True)
        receipts.append({
            "board": "manhattan-cb-06",
            "route": "/community-boards/manhattan-cb-06/",
            "admission_state": "dense_no_js",
            "viewport": {"width": 1440, "height": 900},
            "javascript_enabled": False,
            "list_visible_by_default": no_js_list_visible,
            "month_control_present": no_js_month_reachable,
            "screenshot": str(shot.relative_to(ROOT)),
            "assertion": (
                f"no-JS: list_visible_by_default={no_js_list_visible} "
                f"month_control_present={no_js_month_reachable}"
            ),
        })
        page.close()
        no_js_context.close()
        browser.close()

    server.shutdown()

    # This card is accountable for the Month/List markup it adds, not for
    # pre-existing accessibility issues elsewhere on the Community Board
    # document (tracked separately, out of CBICS-04 scope). Gate on the
    # scoped result; report the full-page result for visibility.
    cbics04_axe_pass = all(
        r["axe_board_proceedings_view"]["passes"]
        for r in receipts
        if r.get("axe_board_proceedings_view")
    )
    full_page_axe_pass = all(
        r["axe_full_page"]["passes"] for r in receipts if "axe_full_page" in r
    )
    receipt = {
        "schema": "cityscroll.community_board_calendar_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "source_vintage": "site/data/community_board_meeting_index.json and related committed Community Board sources, as built by tools/build_community_board_constellation_documents.mjs",
        "cbics04_markup_axe_pass": cbics04_axe_pass,
        "full_page_axe_pass": full_page_axe_pass,
        "note": (
            "full_page_axe_pass may be false from pre-existing, unrelated "
            "issues in sections this card does not own (see per-capture "
            "axe_full_page.failing_violations); this script gates only on "
            "cbics04_markup_axe_pass."
        ),
        "captures": receipts,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"wrote {len(receipts)} captures under {OUT}")
    if not cbics04_axe_pass:
        print("AXE FAILURES DETECTED IN CBICS-04 MARKUP", file=sys.stderr)
        sys.exit(1)
    if not full_page_axe_pass:
        print("note: pre-existing, unrelated full-page axe violations present (see receipt)", file=sys.stderr)


if __name__ == "__main__":
    main()
