#!/usr/bin/env python3
"""Capture and verify the rendered Staffing browse cleanup at review widths."""
from __future__ import annotations

import argparse
import functools
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "browse-staffing-cleanup"
VIEWPORTS = ((390, 844), (1440, 900))

sys.path.insert(0, str(ROOT / "tools"))
from local_site_server import QuietHandler  # noqa: E402

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("before", "after"))
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    failures: list[str] = []  # Derived browser assertions; no sourced data.
    captures: list[str] = []  # Repository-relative paths created by this run.

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                install_routes(page)
                page.goto(f"{base}/browse/staffing/", wait_until="load")
                page.locator("#career-results .career-card").first.wait_for(state="visible")
                guide = page.locator("#career-guide")

                unknown = page.locator('#career-guide [data-facet-value="unknown"]').count()
                area_cards = page.locator("#career-area-watches .career-area-watch").count()
                refresh_blocks = page.get_by_text("Sources and refresh rules", exact=True).count()
                if args.stage == "before":
                    if unknown < 1:
                        failures.append(f"{width}px: unpublished facet placeholder was not reproduced")
                    if area_cards < 7:
                        failures.append(f"{width}px: duplicate interest cards were not reproduced")
                    if refresh_blocks != 1:
                        failures.append(f"{width}px: refresh-rules block was not reproduced")
                else:
                    if unknown:
                        failures.append(f"{width}px: {unknown} unpublished facet placeholders remain")
                    if area_cards:
                        failures.append(f"{width}px: {area_cards} duplicate interest cards remain")
                    if refresh_blocks:
                        failures.append(f"{width}px: refresh-rules block remains")
                    page.locator('[data-career-facet="people:interest:public-safety"]').click()
                    page.locator('[data-interest-context="public-safety"]').wait_for(state="visible")
                    context = page.locator('[data-interest-context="public-safety"]')
                    if context.locator("[data-follow-exam-area]").count() != 1:
                        failures.append(f"{width}px: selected interest has no subscribe action")
                    if context.locator("[data-open-window-band], [data-noe-state]").count() < 1:
                        failures.append(f"{width}px: selected interest has no useful counts")

                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{width}px: horizontal overflow is {overflow}px")
                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    target = OUTPUT / f"{args.stage}-{width}.png"
                    guide.screenshot(path=target, animations="disabled")
                    captures.append(str(target.relative_to(ROOT)))
                page.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    result = {
        "stage": args.stage,
        "route": "/browse/staffing/",
        "captured_viewports": [width for width, _ in VIEWPORTS],
        "captures": captures,
        "failures": failures,
    }
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
