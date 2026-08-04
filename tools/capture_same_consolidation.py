#!/usr/bin/env python3
"""Capture appointment same-except-name consolidation and its render-cost receipt."""
from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "site" / "media" / "review" / "same-consolidation"
RECEIPT = ROOT / "docs" / "evidence" / "same-consolidation" / "perf.json"
VIEWPORTS = ((390, 844), (1440, 900))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("before", "after"))
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    server = None
    if args.stage == "before":
        base = "https://cityscroll.org/"
    else:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/"

    failures = []  # Runtime viewport-check results; no sourced data.
    captures = []  # Paths created by this run; no sourced data.
    measurements = []  # Browser timings measured below; no sourced constants.
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                if args.stage == "after":
                    for pattern in (
                        "https://data.cityofnewyork.us/**",
                        "https://api.cityscroll.org/**",
                        "https://static.cloudflareinsights.com/**",
                        "https://challenges.cloudflare.com/**",
                    ):
                        page.route(pattern, lambda route: route.abort())

                page.goto(base + "#people?view=guide", wait_until="load", timeout=60000)
                page.locator("#staffing-ledger").evaluate("el => { el.open = true; }")
                ready = (
                    page.locator("#staffing-notice-list .staffing-hire-group").first
                    if args.stage == "after"
                    else page.locator("#staffing-notice-list .staffing-hire-row").first
                )
                ready.wait_for(state="visible", timeout=30000)
                ready_ms = page.evaluate("performance.now()")

                groups = page.locator("#staffing-notice-list .staffing-hire-group")
                rows = page.locator("#staffing-notice-list .staffing-hire-row")
                if args.stage == "before" and groups.count():
                    failures.append(f"{width}px: production baseline already renders consolidated groups")
                if args.stage == "after":
                    counts = groups.evaluate_all(
                        "els => els.map(el => Number(el.dataset.groupCount)).sort((a,b) => b-a)"
                    )
                    if counts != [29, 23]:
                        failures.append(f"{width}px: expected group counts [29, 23], got {counts}")
                    if rows.count() != 28:
                        failures.append(f"{width}px: expected 28 distinct rows, got {rows.count()}")

                page.locator("#staffing-feed-meta-heading").evaluate(
                    "el => el.scrollIntoView({block:'start'})"
                )
                page.wait_for_timeout(150)
                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{width}px: horizontal overflow is {overflow}px")

                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    target = OUTPUT / f"{args.stage}-{width}.png"
                    page.screenshot(path=target, animations="disabled")
                    captures.append(str(target.relative_to(ROOT)))

                measurement = {
                    "viewport": width,
                    "ready_ms_from_navigation_start": round(ready_ms, 2),
                    "individual_row_nodes": rows.count(),
                    "group_nodes": groups.count(),
                }
                if args.stage == "after":
                    benchmark = page.evaluate("""async () => {
                      const mod = await import('./same_consolidation.mjs');
                      const rows = globalThis.staffingVisibleItems();
                      const options = {
                        fields:['role','person','agency','effective_date','salary','title_code','published_at'],
                        except:['person'], threshold:3,
                      };
                      for(let i=0;i<50;i++) mod.groupSameExcept(rows,options);
                      const iterations=2000;
                      const started=performance.now();
                      let entries=[];
                      for(let i=0;i<iterations;i++) entries=mod.groupSameExcept(rows,options);
                      const total=performance.now()-started;
                      return {
                        source_rows:rows.length,
                        rendered_entries:entries.length,
                        iterations,
                        total_ms:total,
                        mean_ms:total/iterations,
                      };
                    }""")
                    measurement["grouping_benchmark"] = {
                        key: round(value, 4) if isinstance(value, float) else value
                        for key, value in benchmark.items()
                    }
                    groups.first.locator("summary").click()
                    if groups.first.locator(".staffing-hire-group-names li").count() not in (23, 29):
                        failures.append(f"{width}px: expanded group list count does not match its header")
                    if not args.verify_only:
                        groups.first.evaluate("el => el.scrollIntoView({block:'start'})")
                        page.wait_for_timeout(100)
                        expanded = OUTPUT / f"after-expanded-{width}.png"
                        page.screenshot(path=expanded, animations="disabled")
                        captures.append(str(expanded.relative_to(ROOT)))
                measurements.append(measurement)
                page.close()
            browser.close()
    finally:
        if server:
            server.shutdown()

    if args.stage == "after" and not args.verify_only:
        RECEIPT.parent.mkdir(parents=True, exist_ok=True)
        RECEIPT.write_text(json.dumps({
            "schema_version": 1,
            "measurement": "exact same-except-name grouping on the committed 80-row Staffing snapshot",
            "viewports": measurements,
        }, indent=2) + "\n")

    print(json.dumps({
        "stage": args.stage,
        "captures": captures,
        "measurements": measurements,
        "failures": failures,
    }, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
