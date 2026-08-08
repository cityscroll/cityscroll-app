#!/usr/bin/env python3
"""Before/after notice-page de-slop captures at mobile (390) and desktop (1440).

Local static site only. City Record + lifecycle + prior-cycle are fixture-routed.

  python3 tools/capture_notice_deslop.py
"""
from __future__ import annotations

import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "notice-deslop"
NOTICE_ID = "20260708001"
VIEWPORTS = ((390, 900), (1440, 1100))

NOTICE = {
    "request_id": NOTICE_ID,
    "agency_name": "Housing Preservation and Development",
    "type_of_notice_description": "Solicitation",
    "category_description": "Construction/Construction Services",
    "short_title": "REQUIREMENTS CONTRACT FOR GENERAL CONSTRUCTION SERVICES",
    "selection_method_description": "Competitive Sealed Bid",
    "section_name": "Procurement",
    "start_date": "2026-07-08T00:00:00.000",
    "end_date": "2026-08-20T17:00:00.000",
    "pin": "80626B0060",
    "additional_description_1": (
        "All responses must be submitted through PASSPort. "
        "Search EPIN 80626B0060 in the public RFx list."
    ),
    "address_to_request": "PASSPort Public RFx",
    "contact_name": "Procurement",
    "email": "example@example.com",
}

LIFECYCLE = {
    "ok": True,
    "pin": "80626B0060",
    "pin_strategy": "exact",
    "timeline": [
        {
            "stage": "solicitation",
            "status": "matched",
            "source": "city-record",
            "date": "2026-07-08",
            "detail": {"request_id": NOTICE_ID},
        }
    ],
    "rfx_detail": {
        "status": "unmatched",
        "reason": "no_epin_pin_join",
        "portal": "https://a0333-passportpublic.nyc.gov/rfx.html",
    },
}

PRIOR_CYCLE = {
    "ok": True,
    "id": NOTICE_ID,
    "strict": [],
    "eligibleCount": 0,
    "near": [],
}

BEFORE_GUIDE_HTML = """
<section class="next-action-rail">
  <h3>What can I do now?</h3>
  <div class="next-action-list">
    <a class="act primary" href="https://a0333-passportpublic.nyc.gov/rfx.html" target="_blank" rel="noopener noreferrer">
      Find RFx in PASSPort<span class="act-official">a0333-passportpublic.nyc.gov</span>
    </a>
    <button class="act" type="button">Add deadline to calendar</button>
    <a class="act" href="/following/">Watch this notice</a>
  </div>
  <details class="bid-guide" open>
    <summary>How to respond</summary>
    <dl class="bid-guide-facts">
      <dt>Search ID</dt><dd><code>80626B0060</code></dd>
      <dt>Procurement name</dt><dd><code>REQUIREMENTS CONTRACT FOR GENERAL CONSTRUCTION SERVICES</code></dd>
      <dt>Submit / request to</dt><dd>PASSPort Public RFx</dd>
    </dl>
    <ol>
      <li><span class="guide-warning">The official action link is not published here.</span></li>
      <li>Open the RFx list and search the exact EPIN or procurement name shown above. PASSPort does not publish a stable link to one RFx.</li>
      <li>CityScroll could not match this notice to the public RFx list. Try both search terms and verify the result against the official notice.</li>
      <li>Sign in to PASSPort, open the matching RFx, acknowledge it, and complete the response there before the deadline.</li>
    </ol>
  </details>
</section>
"""

BEFORE_PRIOR_HTML = (
    '<div class="note">No earlier Housing Preservation and Development award matches this title '
    "— most likely not a repeating contract (or an earlier round was titled differently).</div>"
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self):
        # Match tools/local_site_server.py: clean /notices/* document routes use the SPA shell.
        raw = self.path
        path_only, _, query = raw.partition("?")
        route = path_only.rstrip("/")
        if (
            route.startswith("/notices/")
            or route.startswith("/agencies/")
            or route.startswith("/vendors/")
            or route.startswith("/officials/")
            or route == "/now"
            or route == "/browse"
            or route.startswith("/browse/")
        ):
            self.path = "/index.html" + (f"?{query}" if query else "")
        super().do_GET()


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def fulfill_json(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def install_routes(page) -> None:
    def city_data(route: Route) -> None:
        url = route.request.url
        if "dg92-zbpx" in url and NOTICE_ID in url:
            fulfill_json(route, [NOTICE])
        elif "dg92-zbpx" in url:
            fulfill_json(route, [])
        else:
            route.continue_()

    def worker(route: Route) -> None:
        url = route.request.url
        if "contract-lifecycle" in url:
            fulfill_json(route, LIFECYCLE)
        elif "priorcycle" in url:
            fulfill_json(route, PRIOR_CYCLE)
        else:
            fulfill_json(route, {"ok": True})

    page.route("**/resource/dg92-zbpx.json**", city_data)
    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://api.crol-list.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        with StaticServer() as base:
            for width, height in VIEWPORTS:
                label = "mobile" if width <= 500 else "desktop"
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()
                install_routes(page)
                page.goto(
                    f"{base}notices/{NOTICE_ID}",
                    wait_until="domcontentloaded",
                    timeout=60000,
                )
                page.wait_for_selector("#noticeview .panel", timeout=45000)
                page.wait_for_selector("#nactions .bid-guide, #nactions .next-action-rail", timeout=20000)
                page.wait_for_timeout(1000)

                # Before: inject retired multi-block disclaimer chrome on the live shell.
                page.locator("#nactions").evaluate(
                    "(el, html) => { el.innerHTML = html; }",
                    BEFORE_GUIDE_HTML,
                )
                if page.locator("#nprior").count():
                    page.locator("#nprior").evaluate(
                        "(el, html) => { el.innerHTML = html; }",
                        BEFORE_PRIOR_HTML,
                    )
                page.evaluate(
                    "document.querySelector('#noticeview .panel')?.scrollIntoView({block:'start'})"
                )
                page.wait_for_timeout(200)
                page.locator("#noticeview .panel").first.screenshot(
                    path=str(OUT / f"before-{label}.png")
                )

                # After: fresh load with shared-component de-slop.
                page.goto(
                    f"{base}notices/{NOTICE_ID}",
                    wait_until="domcontentloaded",
                    timeout=60000,
                )
                page.wait_for_selector("#noticeview .panel", timeout=45000)
                page.wait_for_selector("#nactions .bid-guide", timeout=20000)
                page.wait_for_timeout(1000)
                guide_text = page.locator("#nactions .bid-guide").inner_text().lower()
                assert "could not match" not in guide_text, guide_text
                assert "not published here" not in guide_text, guide_text
                assert "does not publish a stable link" not in guide_text, guide_text
                assert "search by the epin" in guide_text or "epin" in guide_text
                if page.locator("#nprior").count():
                    prior_html = page.locator("#nprior").inner_html().lower()
                    assert "most likely not a repeating" not in prior_html
                    assert "matches this title" not in prior_html
                page.evaluate(
                    "document.querySelector('#noticeview .panel')?.scrollIntoView({block:'start'})"
                )
                page.wait_for_timeout(200)
                page.locator("#noticeview .panel").first.screenshot(
                    path=str(OUT / f"after-{label}.png")
                )
                context.close()
        browser.close()

    receipt = {
        "notice_id": NOTICE_ID,
        "viewports": [w for w, _ in VIEWPORTS],
        "cuts": [
            "absence caveat: no earlier award matches this title",
            "guide: official action link is not published here",
            "guide: CityScroll could not match this notice",
            "guide: PASSPort does not publish a stable link",
        ],
        "shared_component_fixes": [
            "site/app/money-history.mjs priorCycleNoneHTML / priorCycleHTML / nearMatchHTML",
            "site/app/feed-actions.mjs actionRailGuideHTML PASSPort steps",
            "site/i18n.js bid_guide_passport_search_step + retired absence keys",
        ],
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote before/after screenshots to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
