#!/usr/bin/env python3
"""Headless evidence capture for the shared compact month component (CBICS-02).

Mounts test/harness/compact_calendar_harness.html — a neutral, unshipped
fixture page — against the committed fixtures in
test/fixtures/compact_calendar_fixtures.mjs, then for each fixture x viewport:
records a screenshot, runs the vendored axe-core accessibility gate (the same
rule set and pass/fail classification as test/functional/11_accessibility.py),
and writes a receipt naming the viewport, git revision, fixture/data state,
timezone, and the resulting assertion. One additional pass captures the print
media form of the dense fixture.

No public route is created or mounted; the harness page is test-only.
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
OUT = ROOT / "docs" / "screenshots" / "compact-calendar-component"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
FIXTURES = ["dense", "crowded", "lifecycle", "sparse"]
TODAY = "2026-03-15"
TIMEZONE = "America/New_York"


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
    OUT.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}/test/harness/compact_calendar_harness.html"

    receipts = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for fixture in FIXTURES:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(f"{base}?fixture={fixture}&today={TODAY}", wait_until="domcontentloaded")
                page.wait_for_selector("#page[data-harness-state]", state="attached")
                state = page.locator("#page").get_attribute("data-harness-state")
                reason = page.locator("#page").get_attribute("data-harness-reason")
                shot = OUT / f"{fixture}-{width}x{height}.png"
                page.screenshot(path=str(shot), full_page=True)
                axe_result = run_axe(page)
                receipts.append({
                    "fixture": fixture,
                    "viewport": {"width": width, "height": height},
                    "timezone": TIMEZONE,
                    "today": TODAY,
                    "harness_state": state,
                    "harness_reason": reason,
                    "screenshot": str(shot.relative_to(ROOT)),
                    "axe": axe_result,
                    "assertion": (
                        f"fixture={fixture} at {width}x{height} rendered={state == 'rendered'} "
                        f"reason={reason} axe_passes={axe_result['passes']}"
                    ),
                })
                page.close()

        # Print-relevant captures at desktop width, print media: the dense
        # fixture (baseline) and the crowded fixture, which is the one that
        # actually exercises the forced-open overflow disclosure in print.
        for print_fixture in ("dense", "crowded"):
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.goto(f"{base}?fixture={print_fixture}&today={TODAY}", wait_until="domcontentloaded")
            page.wait_for_selector("#page[data-harness-state]", state="attached")
            page.emulate_media(media="print")
            # Playwright's emulate_media does not fire the real print event, so
            # dispatch it explicitly for bindCompactMonthPrintDisclosure to react to.
            page.evaluate("() => window.dispatchEvent(new Event('beforeprint'))")
            print_shot = OUT / f"{print_fixture}-print-1440x900.png"
            page.screenshot(path=str(print_shot), full_page=True)
            grid_visible = page.locator(".compact-month-grid").is_visible()
            agenda_visible = page.locator(".compact-month-agenda").is_visible()
            overflow_open_in_print = page.evaluate(
                "() => { const rest = document.querySelector('.compact-month-overflow > *:not(summary)');"
                " return { hasOverflow: Boolean(document.querySelector('.compact-month-overflow')),"
                " restVisible: rest ? getComputedStyle(rest).display !== 'none' : null }; }"
            )
            receipts.append({
                "fixture": print_fixture,
                "viewport": {"width": 1440, "height": 900},
                "media": "print",
                "timezone": TIMEZONE,
                "today": TODAY,
                "screenshot": str(print_shot.relative_to(ROOT)),
                "grid_visible_in_print": grid_visible,
                "agenda_visible_in_print": agenda_visible,
                "overflow_forced_open_in_print": overflow_open_in_print,
                "assertion": (
                    f"print media ({print_fixture}): grid_visible={grid_visible} "
                    f"agenda_visible={agenda_visible} overflow_open={overflow_open_in_print}"
                ),
            })
            page.close()
        browser.close()

    server.shutdown()

    all_axe_pass = all(r.get("axe", {}).get("passes", True) for r in receipts)
    receipt = {
        "schema": "cityscroll.compact_calendar_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "timezone": TIMEZONE,
        "today": TODAY,
        "all_axe_pass": all_axe_pass,
        "captures": receipts,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"wrote {len(receipts)} captures under {OUT}")
    if not all_axe_pass:
        print("AXE FAILURES DETECTED", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
