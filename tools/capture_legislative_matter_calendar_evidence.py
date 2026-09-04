#!/usr/bin/env python3
"""Headless evidence capture for the legislative matter appearance calendar (CBICS-09).

Serves the real `/matters/:id/` route HTML that `site/pages_edge.mjs` produced
for four fixtures (`tools/render_legislative_matter_calendar_fixtures.mjs`) —
concentrated, dispersed, sparse, and no-decision — from a neutral local static
server, then for each fixture x viewport: records a screenshot, runs the
vendored axe-core accessibility gate (same rule set and pass/fail
classification as test/functional/11_accessibility.py), and writes a receipt
naming the route, viewport, git revision, evidence/action state, and the
resulting assertion.

Run `node tools/render_legislative_matter_calendar_fixtures.mjs` first.
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
FIXTURES_DIR = ROOT / "docs" / "screenshots" / "legislative-matter-calendar" / "fixtures"
OUT = ROOT / "docs" / "screenshots" / "legislative-matter-calendar"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]

SCENARIOS = {
    "concentrated": {"route": "/matters/78601/", "evidence_state": "3 appearances in a 15-day span; one carries a proven 8-0-1 committee vote", "assertion_kind": "calendar renders above the appearances list"},
    "dispersed": {"route": "/matters/78602/", "evidence_state": "3 appearances spanning Jan-Sep, no 42-day dense window", "assertion_kind": "list-only, no calendar furniture"},
    "sparse": {"route": "/matters/78603/", "evidence_state": "2 appearances (the real committed LU 0056-2026 shape)", "assertion_kind": "list-only, below the 3-occurrence threshold"},
    "no-decision": {"route": "/matters/78604/", "evidence_state": "3 concentrated appearances, no committee/Council action or vote retained on any", "assertion_kind": "calendar renders, no vote/action text on any cell"},
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


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
        "passes": len(gate) == 0,
    }


def main() -> None:
    if not FIXTURES_DIR.exists():
        print(f"missing {FIXTURES_DIR} — run node tools/render_legislative_matter_calendar_fixtures.mjs first", file=sys.stderr)
        sys.exit(1)
    OUT.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fixtures_rel = FIXTURES_DIR.relative_to(ROOT)

    receipts = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for scenario_id, meta in SCENARIOS.items():
            html_url = f"http://127.0.0.1:{port}/{fixtures_rel}/{scenario_id}.html"
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(html_url, wait_until="domcontentloaded")
                calendar_present = page.locator(".compact-month").count() > 0
                vote_leak = page.locator(".compact-month").locator("text=/\\byes\\b|\\bvote\\b|\\babstain\\b/i").count() if calendar_present else 0
                shot = OUT / f"{scenario_id}-{width}x{height}.png"
                page.screenshot(path=str(shot), full_page=True)
                axe_result = run_axe(page)
                receipts.append({
                    "scenario": scenario_id,
                    "route": meta["route"],
                    "viewport": {"width": width, "height": height},
                    "revision": revision,
                    "evidence_state": meta["evidence_state"],
                    "calendar_rendered": calendar_present,
                    "calendar_carries_no_decision_language": vote_leak == 0,
                    "screenshot": str(shot.relative_to(ROOT)),
                    "axe": axe_result,
                    "assertion": (
                        f"{scenario_id} ({meta['route']}) at {width}x{height}: {meta['assertion_kind']}; "
                        f"calendar_rendered={calendar_present} no_decision_leak={vote_leak == 0} "
                        f"axe_passes={axe_result['passes']}"
                    ),
                })
                page.close()
        browser.close()

    server.shutdown()

    all_axe_pass = all(r.get("axe", {}).get("passes", True) for r in receipts)
    expected_render = {"concentrated": True, "dispersed": False, "sparse": False, "no-decision": True}
    all_render_correct = all(
        r["calendar_rendered"] == expected_render[r["scenario"]] for r in receipts
    )
    all_no_leak = all(r["calendar_carries_no_decision_language"] for r in receipts)
    receipt = {
        "schema": "cityscroll.legislative_matter_calendar_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "all_axe_pass": all_axe_pass,
        "all_render_correct": all_render_correct,
        "all_no_decision_leak": all_no_leak,
        "captures": receipts,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"wrote {len(receipts)} captures under {OUT}")
    if not (all_axe_pass and all_render_correct and all_no_leak):
        print("EVIDENCE CAPTURE FAILURES DETECTED", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
