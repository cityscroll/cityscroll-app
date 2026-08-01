#!/usr/bin/env python3
"""Capture the NYCHA solicitation handoff before/after at desktop and mobile widths.

The page is the real CityScroll frontend served locally. Only the City Record and lifecycle
responses are fixture-routed, which keeps the field case deterministic while exercising the
same action registry and lifecycle hydration used in production.

  python3 tools/capture_passport_bid_guide.py
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "passport-bid-guide"
NOTICE_ID = "20260617050"
PORT = 8767


def field_case() -> dict:
    examples = json.loads((ROOT / "site" / "data" / "task_first_examples.json").read_text())
    for group in examples.values() if isinstance(examples, dict) else [examples]:
        rows = group if isinstance(group, list) else []
        for row in rows:
            if str(row.get("id")) == NOTICE_ID:
                return row["official"]
    # The current file stores examples below nested task groups; walk those without coupling to
    # the editorial grouping names.
    stack: list[object] = list((examples,))
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            if str(value.get("id")) == NOTICE_ID and isinstance(value.get("official"), dict):
                return value["official"]
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
    raise RuntimeError(f"field case {NOTICE_ID} missing from task_first_examples.json")


def fulfill_json(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    notice = field_case()
    lifecycle = {
        "ok": True,
        "pin": "517992",
        "pin_strategy": "exact",
        "timeline": [
            {
                "stage": "solicitation",
                "status": "matched",
                "source": "city-record",
                "date": "2026-06-30",
                "detail": {"request_id": NOTICE_ID},
            }
        ],
        "rfx_detail": {
            "status": "unmatched",
            "reason": "no_epin_pin_join",
            "portal": "https://a0333-passportpublic.nyc.gov/rfx.html",
        },
    }
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(PORT), "--directory", str(ROOT / "site")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(0.4)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height, label in ((1440, 1000, "desktop"), (390, 844, "mobile")):
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
                page.route("**/resource/dg92-zbpx.json**", lambda route: fulfill_json(route, [notice]))
                page.route("**/contract-lifecycle**", lambda route: fulfill_json(route, lifecycle))
                page.route("https://api.cityscroll.org/**", lambda route: route.abort())
                page.route("https://crol-worker.crol-worker.workers.dev/**", lambda route: route.abort())
                page.goto(f"http://127.0.0.1:{PORT}/#notice/{NOTICE_ID}", wait_until="domcontentloaded")
                page.wait_for_selector("#nactions .bid-guide")
                page.wait_for_selector("#nactions a[href*='isupplier-vendor-registration']")
                panel = page.locator("#noticeview .panel").first

                # Recreate the exact pre-fix affordance inside the rendered product shell.
                page.locator("#nactions").evaluate(
                    """el => { el.innerHTML = `<section class="next-action-rail">
                      <h3>What can I do now?</h3><div class="next-action-list">
                      <a class="act primary" href="https://a0333-passportpublic.nyc.gov/">
                      <span>Bid on PASSPort<span class="act-official">a0333-passportpublic.nyc.gov</span></span></a>
                      <button class="act">Add deadline to calendar</button><a class="act">Watch this notice</a>
                      </div></section>`; }"""
                )
                panel.screenshot(path=str(OUT / f"before-nycha-{label}.png"))

                page.reload(wait_until="domcontentloaded")
                page.wait_for_selector("#nactions .bid-guide")
                page.wait_for_selector("#nactions a[href*='isupplier-vendor-registration']")
                panel = page.locator("#noticeview .panel").first
                panel.screenshot(path=str(OUT / f"after-nycha-{label}.png"))
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
