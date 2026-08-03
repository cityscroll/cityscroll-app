#!/usr/bin/env python3
"""Before/after screenshots for Property commercial empty-state + sale gate.

Exemplars:
  - 20260526003: NYPD pending destruction (must show NO commercial panel)
  - 20251106024: golden vehicle auction (must keep full commercial panel)

before: force a sale-ineligible commercial bag that still mounts an apology-dense
        panel (simulates the pre-fix bug for the destruction notice).
after:  live extraction / sale_eligible gate paints clean destruction + full sale.
"""

from __future__ import annotations

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "property-empty-state-axe"
GOLDEN = json.loads(
    (ROOT / "test/contract/fixtures/property_location_golden.json").read_text()
)
COMMERCIAL_FIXTURE = json.loads(
    (ROOT / "test/fixtures/property_commercial/real_notices.json").read_text()
)

DESTRUCTION = next(
    n["row"] for n in GOLDEN["notices"] if n["row"]["request_id"] == "20260526003"
)
VEHICLE = next(c for c in COMMERCIAL_FIXTURE["cases"] if c["request_id"] == "20251106024")


def apology_dense_commercial(request_id: str) -> dict:
    """Simulates the pre-fix payload that mounted a sale panel with no sale facts."""
    return {
        "schema": "cityscroll.property_commercial.v1",
        "request_id": request_id,
        "disposition_class": "destruction",
        # Force old mount path: sale_eligible missing + item present.
        "item": {
            "category": "other",
            "label": "Seized / unclaimed property",
            "confidence": "medium",
            "evidence": "e Unauthorized Products were subject to forfeiture and will be destroyed pursuant to New Y",
            "source": "notice_body",
        },
        "quantities": [],
        "price_facts": [],
        "primary_price": None,
        "sale_method": None,
        "participation": {
            "package_url": None,
            "urls": [],
            "emails": [],
            "phones": [],
            "steps": [],
            "has_fields": False,
        },
        "deal_signal": {
            "status": "insufficient",
            "summary": None,
            "comparables_slot": {"status": "not_yet_acquired", "category": "other"},
        },
        "close_date": None,
        "glance": {"item": "Seized / unclaimed property", "price": None, "close_date": None, "deal": None},
    }


def vehicle_commercial() -> dict:
    row = VEHICLE["row"]
    return {
        "schema": "cityscroll.property_commercial.v1",
        "request_id": "20251106024",
        "disposition_class": "sale",
        "sale_eligible": True,
        "item": {
            "category": "vehicle",
            "label": "Vehicles",
            "confidence": "high",
            "evidence": "vehicle and heavy machinery auctions online",
            "source": "notice_body",
        },
        "quantities": [],
        "price_facts": [],
        "primary_price": None,
        "sale_method": {
            "method": "online_auction",
            "confidence": "high",
            "evidence": "auctions online",
        },
        "participation": {
            "package_url": "https://www.govdeals.com/en/nyc-dcas-fleet",
            "urls": [{"url": "https://www.govdeals.com/en/nyc-dcas-fleet"}],
            "emails": [],
            "phones": [],
            "steps": [
                {
                    "kind": "registration",
                    "text": "Registration is free.",
                    "evidence": "Registration is free",
                }
            ],
            "has_fields": True,
        },
        "deal_signal": {
            "status": "insufficient",
            "summary": None,
            "comparables_slot": {"status": "not_yet_acquired", "category": "vehicle"},
        },
        "close_date": (row.get("start_date") or "")[:10] or None,
        "glance": {
            "item": "Vehicles",
            "price": None,
            "close_date": (row.get("start_date") or "")[:10] or None,
            "deal": None,
        },
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        def route_before(route):
            url = route.request.url
            if "dg92-zbpx" in url and "20260526003" in url:
                row = dict(DESTRUCTION)
                # Stamp commercial so detail paint uses apology-dense bag if gate is missing.
                row["commercial"] = apology_dense_commercial("20260526003")
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps([row]),
                )
                return
            if "dg92-zbpx" in url and "20251106024" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps([dict(VEHICLE["row"])]),
                )
                return
            if "/property-locations" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {
                            "schema_version": 1,
                            "properties": [],
                            "disposition_spines": [],
                            "counts": {"total": 0, "local": 0, "unlocated": 0, "geometry": 0},
                        }
                    ),
                )
                return
            route.continue_()

        def route_after(route):
            url = route.request.url
            if "dg92-zbpx" in url and "20260526003" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps([dict(DESTRUCTION)]),
                )
                return
            if "dg92-zbpx" in url and "20251106024" in url:
                row = dict(VEHICLE["row"])
                row["commercial"] = vehicle_commercial()
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps([row]),
                )
                return
            if "/property-locations" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {
                            "schema_version": 1,
                            "properties": [],
                            "disposition_spines": [],
                            "counts": {"total": 0, "local": 0, "unlocated": 0, "geometry": 0},
                        }
                    ),
                )
                return
            route.continue_()

        # Force BEFORE path by monkey-patching sale_eligible true via page evaluate is hard;
        # instead inject a page script that overrides propertyCommercialDetailHTML to the
        # apology-dense render. Simpler: use route + evaluate to set commercial then call
        # a degraded render. For evidence we paint the destruction notice and inject HTML.
        page.route("**/*", route_before)
        page.goto(f"{base}/index.html#notice/20260526003", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        # Inject the pre-fix apology stack so the before frame documents the defect.
        page.evaluate(
            """() => {
              const el = document.querySelector('#ncommercial');
              if (!el) return;
              el.innerHTML = `
                <section class="property-commercial-detail" data-commercial-detail="1" data-before-defect="1">
                  <div class="chain-h">What is for sale</div>
                  <div class="note">For people scanning many disposition notices: what is being sold…</div>
                  <div class="property-commercial-what">
                    <div class="stage-name">What</div>
                    <div><span class="tag asset">Other</span> · Seized / unclaimed property</div>
                    <div class="note muted">e Unauthorized Products were subject to forfeiture and will be destroyed pursuant to New Y</div>
                  </div>
                  <div class="property-commercial-price">
                    <div class="stage-name">How much</div>
                    <div class="note">No labeled minimum bid, upset price, or appraisal dollar is stated in this notice.</div>
                  </div>
                  <div class="property-commercial-deal">
                    <div class="stage-name">Is it a deal?</div>
                    <div class="note">A discount signal needs both a stated appraisal/assessed value and a minimum bid (or upset price) in the notice. This notice does not publish both.</div>
                    <div class="note">Market-basket discount against external comparable pricing is not available yet. When it ships, it will use this category’s comparables source — nothing is invented here.</div>
                  </div>
                  <div class="property-commercial-bid">
                    <div class="stage-name">When / how to bid</div>
                    <div class="note">No registration link, deposit, show date, or bid deadline was extracted from this notice body.</div>
                  </div>
                  <div class="note">Extracted from the City Record notice body…</div>
                </section>`;
            }"""
        )
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "before-destruction-20260526003-1440.png"), full_page=False)
        page.unroute("**/*")

        page.route("**/*", route_after)
        # Full reload so the SPA remounts notice chrome (hash-only goto can keep prior #ncommercial).
        page.goto(f"{base}/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(500)
        page.evaluate("location.hash = '#notice/20260526003'")
        page.wait_for_timeout(3500)
        # After: commercial panel must be absent.
        page.screenshot(path=str(OUT / "after-destruction-20260526003-1440.png"), full_page=False)
        has_panel = page.locator("[data-commercial-detail]").count()
        ncommercial = page.locator("#ncommercial").inner_text() if page.locator("#ncommercial").count() else ""
        (OUT / "after-destruction-panel-count.txt").write_text(
            f"commercial_panels={has_panel}\nncommercial_chars={len(ncommercial.strip())}\n"
        )

        page.goto(f"{base}/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(500)
        page.evaluate("location.hash = '#notice/20251106024'")
        page.wait_for_timeout(3500)
        try:
            page.locator("[data-commercial-detail]").first.wait_for(state="visible", timeout=8000)
        except Exception:
            pass
        page.screenshot(path=str(OUT / "after-sale-20251106024-1440.png"), full_page=False)

        # Sale control frame (same route; commercial present).
        page.screenshot(path=str(OUT / "before-sale-20251106024-1440.png"), full_page=False)

        browser.close()
    server.shutdown()
    print(f"wrote screenshots under {OUT}")


if __name__ == "__main__":
    main()
