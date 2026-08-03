#!/usr/bin/env python3
"""Before/after screenshots for Property commercial glance (surplus-goods buyer).

before: commercial extraction stubbed empty → list/detail lack item+$ lead
after:  commercial payload paints item + price + deal + bid steps

Golden vehicle case: request_id 20251106024 (AUTO AUCTION / GovDeals).
Deal-signal case: synthetic-deal-vehicle-001 embedded in the after fixture.
"""

from __future__ import annotations

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "property-commercial"
FIXTURE = json.loads(
    (ROOT / "test/fixtures/property_commercial/real_notices.json").read_text()
)

AUTO = next(c for c in FIXTURE["cases"] if c["request_id"] == "20251106024")
DEAL = next(c for c in FIXTURE["cases"] if c["request_id"] == "synthetic-deal-vehicle-001")
TIMBER = next(c for c in FIXTURE["cases"] if c["request_id"] == "20190410105")


def commercial_for(case: dict) -> dict:
    """Minimal commercial bag matching extractPropertyCommercial glance fields."""
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
    if case["request_id"] == "synthetic-deal-vehicle-001":
        # Fixture-constructed pair (min $4,800 / appraised $12,000) — not a live measurement.
        price = {"kind": "minimum_bid", "display": "$4,800", "amount": 4800}
        deal = "Minimum bid is 40% of stated appraised value"
    elif case["request_id"] == "20140224112":
        # Source: City Record Online request_id 20140224112 (TLC medallion upset notice).
        price = {"kind": "upset_price", "display": "$850,000", "amount": 850000}
    elif case["request_id"] == "20150915102":
        # Source: City Record Online request_id 20150915102 (DCAS public auction upset table).
        price = {"kind": "upset_price", "display": "$11,000,000", "amount": 11000000}
    package = None
    if exp.get("has_package_url"):
        package = "https://www.govdeals.com/en/nyc-dcas-fleet"
    close = (case["row"].get("event_date") or case["row"].get("start_date") or "")[:10] or None
    item_label = labels.get(category, "Other")
    if category == "timber" and case["request_id"] == "20190410105":
        item_label = "381,000 board feet"
    return {
        "schema": "cityscroll.property_commercial.v1",
        "request_id": case["request_id"],
        "item": {"category": category, "label": labels.get(category), "confidence": "high", "evidence": "fixture", "source": "notice_body"},
        "quantities": [],
        # Synthetic amounts only for synthetic-deal-vehicle-001 (fixture-constructed, not measured).
        "price_facts": (
            [
                {"kind": "appraised", "amount": 12000, "display": "$12,000", "source": "notice_body", "evidence": "appraised at a value of $12,000", "confidence": "high"},
                {"kind": "minimum_bid", "amount": 4800, "display": "$4,800", "source": "notice_body", "evidence": "Minimum bid: $4,800", "confidence": "high"},
            ]
            if case["request_id"] == "synthetic-deal-vehicle-001"
            else []
        ),
        "primary_price": (
            {"kind": "minimum_bid", "amount": 4800, "display": "$4,800", "source": "notice_body", "evidence": "Minimum bid: $4,800", "confidence": "high"}
            if case["request_id"] == "synthetic-deal-vehicle-001"
            else None
        ),
        "sale_method": {"method": exp.get("sale_method") or "online_auction", "confidence": "high", "evidence": "fixture"},
        "participation": {
            "package_url": package,
            "urls": [{"url": package}] if package else [],
            "emails": [],
            "phones": [],
            "steps": [{"kind": "registration", "text": "Registration is free.", "evidence": "Registration is free"}] if package else [],
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
        },
    }


def property_view(with_commercial: bool) -> dict:
    rows = []
    for case in (AUTO, DEAL, TIMBER):
        row = dict(case["row"])
        row["property_location"] = {
            "scope": "unlocated",
            "boroughs": [],
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
        "counts": {"total": len(rows), "local": 0, "unlocated": len(rows), "geometry": 0},
        "properties": rows,
        "disposition_spines": [],
    }


def soda_row(case: dict) -> dict:
    return dict(case["row"])


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
            if "dg92-zbpx" in url and "20251106024" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps([soda_row(AUTO)]),
                )
                return
            if "dg92-zbpx" in url and "synthetic-deal-vehicle-001" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps([soda_row(DEAL)]),
                )
                return
            if "dg92-zbpx" in url:
                # Property list SODA fallback
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps([soda_row(AUTO), soda_row(DEAL), soda_row(TIMBER)]),
                )
                return
            route.continue_()

        # BEFORE: empty commercial bags
        page.route("**/*", lambda r: route_property(r, False))
        page.goto(f"{base}/index.html#property", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.locator("#propertyfeed .fcard").first.wait_for(state="visible", timeout=15000)
        page.screenshot(path=str(OUT / "before-list-1440.png"), full_page=False)
        page.goto(f"{base}/index.html#notice/20251106024", wait_until="domcontentloaded")
        page.wait_for_timeout(2000)
        page.screenshot(path=str(OUT / "before-detail-1440.png"), full_page=False)
        page.unroute("**/*")

        # AFTER: commercial stamped
        page.route("**/*", lambda r: route_property(r, True))
        page.goto(f"{base}/index.html#property", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.locator("#propertyfeed .fcard").first.wait_for(state="visible", timeout=15000)
        # Prefer commercial lead when present
        try:
            page.locator("[data-commercial-glance]").first.wait_for(state="visible", timeout=5000)
        except Exception:
            pass
        page.screenshot(path=str(OUT / "after-list-1440.png"), full_page=False)

        page.goto(f"{base}/index.html#notice/synthetic-deal-vehicle-001", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        try:
            page.locator("[data-commercial-detail], [data-deal-status]").first.wait_for(
                state="visible", timeout=8000
            )
        except Exception:
            pass
        page.screenshot(path=str(OUT / "after-detail-deal-1440.png"), full_page=False)

        page.goto(f"{base}/index.html#notice/20251106024", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / "after-detail-vehicle-1440.png"), full_page=False)

        browser.close()
    server.shutdown()
    print(f"wrote screenshots under {OUT}")


if __name__ == "__main__":
    main()
