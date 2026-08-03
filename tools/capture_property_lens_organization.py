#!/usr/bin/env python3
"""Before/after screenshots for Property commercial lens organization.

before: list without commercial filter rails / method chips on cards
after:  item type + sale method + price rails, sort, commercial glance on cards

Uses fixture commercial bags so the capture does not depend on live Worker materialization.
"""

from __future__ import annotations

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "property-lens-organization"
FIXTURE = json.loads(
    (ROOT / "test/fixtures/property_commercial/real_notices.json").read_text()
)

CASES = [
    next(c for c in FIXTURE["cases"] if c["request_id"] == "20251106024"),
    next(c for c in FIXTURE["cases"] if c["request_id"] == "synthetic-deal-vehicle-001"),
    next(c for c in FIXTURE["cases"] if c["request_id"] == "20190410105"),
    next(c for c in FIXTURE["cases"] if c["request_id"] == "20150915102"),
]


def commercial_for(case: dict) -> dict:
    exp = case["expect"]
    category = exp["category"]
    labels = {
        "vehicle": "Vehicles",
        "timber": "Timber / firewood",
        "real_property": "Real property",
        "equipment": "Equipment",
        "scrap_materials": "Scrap / materials",
        "other": "Other",
    }
    price = None
    deal = None
    amount = None
    if case["request_id"] == "synthetic-deal-vehicle-001":
        # source: synthetic-deal-vehicle-001 fixture pair (min bid / appraised)
        price = {"kind": "minimum_bid", "display": "$4,800", "amount": 4800}
        amount = 4800  # source: synthetic-deal-vehicle-001
        deal = "Minimum bid is 40% of stated appraised value"
    elif case["request_id"] == "20150915102":
        # source: City Record notice 20150915102 upset price table
        price = {"kind": "upset_price", "display": "$11,000,000", "amount": 11000000}
        amount = 11000000  # source: City Record 20150915102
    elif case["request_id"] == "20140224112":
        # source: City Record notice 20140224112 medallion upset
        price = {"kind": "upset_price", "display": "$850,000", "amount": 850000}
        amount = 850000  # source: City Record 20140224112
    method = exp.get("sale_method") or "online_auction"
    package = "https://www.govdeals.com/en/nyc-dcas-fleet" if exp.get("has_package_url") else None
    close = (case["row"].get("event_date") or case["row"].get("start_date") or "")[:10] or None
    item_label = labels.get(category, "Other")
    if category == "timber" and case["request_id"] == "20190410105":
        item_label = "381,000 board feet"
    primary = None
    if amount is not None and price:
        primary = {
            "kind": price["kind"],
            "amount": amount,
            "display": price["display"],
            "source": "notice_body",
            "evidence": "fixture",
            "confidence": "high",
        }
    return {
        "schema": "cityscroll.property_commercial.v1",
        "request_id": case["request_id"],
        "disposition_class": "sale",
        "sale_eligible": True,
        "item": {
            "category": category,
            "label": labels.get(category),
            "confidence": "high",
            "evidence": "fixture",
            "source": "notice_body",
        },
        "quantities": [],
        "price_facts": [primary] if primary else [],
        "primary_price": primary,
        "sale_method": {"method": method, "confidence": "high", "evidence": "fixture"},
        "participation": {
            "package_url": package,
            "urls": [{"url": package}] if package else [],
            "emails": [],
            "phones": [],
            "steps": [{"kind": "registration", "text": "Registration is free."}] if package else [],
            "has_fields": bool(package),
        },
        "deal_signal": {
            "status": "derived" if deal else "insufficient",
            "pct_of_value": 40 if deal else None,
            "summary": deal,
            "method": "stated_value_discount",
            "comparables_slot": {"status": "not_yet_acquired", "category": category},
        },
        "close_date": close,
        "glance": {
            "item": item_label,
            "price": price,
            "close_date": close,
            "deal": deal,
            "sale_method": method,
        },
    }


def property_view(with_commercial: bool) -> dict:
    rows = []
    for case in CASES:
        row = dict(case["row"])
        row["property_location"] = {
            "scope": "borough",
            "boroughs": ["Brooklyn"] if case["request_id"].startswith("2025") else ["Manhattan"],
            "neighborhoods": [],
            "addresses": [],
            "tax_lots": [],
            "bbls": [],
            "geometry": None,
        }
        row["disposition_stage"] = "auction_or_rfp"
        if with_commercial:
            row["commercial"] = commercial_for(case)
        rows.append(row)
    return {
        "schema_version": 1,
        "generated_at": "2026-08-03T12:00:00.000Z",
        "view": "list",
        "source": {"name": "City Record Online", "dataset": "dg92-zbpx"},
        "counts": {"total": len(rows), "local": 0, "unlocated": 0, "geometry": 0},
        "properties": rows,
        "disposition_spines": [],
        "commercial_metrics": {
            "metric": "property_commercial_price_coverage",
            "n": len(rows),
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

        def route_property(route, with_commercial: bool):
            url = route.request.url
            if "/property-locations" in url or "property:location" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(property_view(with_commercial)),
                )
                return
            if "dg92-zbpx" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps([dict(c["row"]) for c in CASES]),
                )
                return
            route.continue_()

        # BEFORE: no commercial stamp → rails present but glance weak / no method chip
        page.route("**/*", lambda r: route_property(r, False))
        page.goto(f"{base}/index.html#property", wait_until="domcontentloaded")
        page.wait_for_timeout(2800)
        page.locator("#propertyfeed .fcard").first.wait_for(state="visible", timeout=20000)
        page.screenshot(path=str(OUT / "before-list-1440.png"), full_page=False)
        page.unroute("**/*")

        # AFTER: commercial stamp + organize filters
        page.route("**/*", lambda r: route_property(r, True))
        page.goto(f"{base}/index.html#property", wait_until="domcontentloaded")
        page.wait_for_timeout(2800)
        page.locator("#propertyfeed .fcard").first.wait_for(state="visible", timeout=20000)
        try:
            page.locator("[data-commercial-glance]").first.wait_for(state="visible", timeout=8000)
        except Exception:
            pass
        page.screenshot(path=str(OUT / "after-list-1440.png"), full_page=False)

        # Filter: vehicles only
        try:
            page.locator('#assettabs .chip[data-a="vehicle"]').click(timeout=5000)
            page.wait_for_timeout(800)
        except Exception:
            pass
        page.screenshot(path=str(OUT / "after-filter-vehicle-1440.png"), full_page=False)

        # Sort price high→low
        try:
            page.select_option("#propsort", "price_desc")
            page.wait_for_timeout(800)
        except Exception:
            pass
        page.screenshot(path=str(OUT / "after-sort-price-1440.png"), full_page=False)

        # Mobile after
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{base}/index.html#property?asset=vehicle&method=online_auction&sort=closing_soon", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        try:
            page.locator("#propertyfeed .fcard").first.wait_for(state="visible", timeout=15000)
        except Exception:
            pass
        page.screenshot(path=str(OUT / "after-list-390.png"), full_page=False)

        browser.close()
    server.shutdown()
    print(f"wrote screenshots under {OUT}")


if __name__ == "__main__":
    main()
