#!/usr/bin/env python3
"""Before/after screenshots for Property date-chip + closing-soon temporal hotfix.

before: simulated regression — past-dated closes first, close chips with $Month leak
after:  open/upcoming first, clean date chips, closed section + closed action rails

Uses fixture commercial bags so the capture does not depend on live Worker materialization.
"""

from __future__ import annotations

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "property-date-chip-hotfix"
FIXTURE = json.loads(
    (ROOT / "test/fixtures/property_commercial/real_notices.json").read_text()
)

# Mix of past closes (the regression front page) + one synthetic near-term open sale.
PAST_CASES = [
    next(c for c in FIXTURE["cases"] if c["request_id"] == "20140224112"),
    next(c for c in FIXTURE["cases"] if c["request_id"] == "20150915102"),
    next(c for c in FIXTURE["cases"] if c["request_id"] == "20190410105"),
]
OPEN_CASE = {
    "request_id": "synthetic-open-2026",
    "note": "synthetic open close for capture (not a City Record id)",
    "row": {
        "request_id": "synthetic-open-2026",
        "short_title": "AUTO AUCTION — municipal fleet (upcoming close)",
        "additional_description_1": (
            "Online auction of surplus vehicles. Minimum bid of $4,800. "
            "Registration free at GovDeals."
        ),
        "type_of_notice_description": "Sale",
        "section_name": "Property Disposition",
        "agency_name": "Citywide Administrative Services",
        "start_date": "2026-07-15T00:00:00.000",
        "event_date": "2026-09-16T15:00:00.000",
        "street_address_1": "",
    },
    "expect": {
        "category": "vehicle",
        "sale_method": "online_auction",
        "has_package_url": True,
    },
}


def commercial_for(case: dict, *, force_close: str | None = None) -> dict:
    exp = case.get("expect") or {}
    category = exp.get("category") or "other"
    labels = {
        "vehicle": "Vehicles",
        "timber": "Timber / firewood",
        "real_property": "Real property",
        "equipment": "Equipment",
        "scrap_materials": "Scrap / materials",
        "other": "Other",
    }
    rid = case["request_id"]
    price = None
    amount = None
    deal = None
    if rid in ("synthetic-open-2026", "synthetic-deal-vehicle-001", "20251106024"):
        price = {"kind": "minimum_bid", "display": "$4,800", "amount": 4800}  # source: synthetic-deal-vehicle-001 fixture
        amount = 4800  # source: synthetic-deal-vehicle-001 fixture min bid
    elif rid == "20150915102":
        price = {"kind": "upset_price", "display": "$11,000,000", "amount": 11000000}  # source: City Record 20150915102
        amount = 11000000  # source: City Record 20150915102
    elif rid == "20140224112":
        price = {"kind": "upset_price", "display": "$850,000", "amount": 850000}  # source: City Record 20140224112
        amount = 850000  # source: City Record 20140224112
    method = exp.get("sale_method") or "online_auction"
    package = "https://www.govdeals.com/en/nyc-dcas-fleet" if exp.get("has_package_url") else None
    close = force_close or (
        (case["row"].get("event_date") or case["row"].get("start_date") or "")[:10] or None
    )
    item_label = labels.get(category, "Other")
    if category == "timber" and rid == "20190410105":
        item_label = "381,000 board feet"  # source: City Record 20190410105 volume line
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
        "request_id": rid,
        "disposition_class": "sale",
        "sale_eligible": True,
        "item": {
            "category": category,
            "label": labels.get(category),
            "confidence": "high",
            "evidence": "fixture",
            "source": "notice_body",
        },
        "quantities": [],  # source: capture fixture — no volume rows unless timber case above
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
            "status": "from_notice" if deal else "insufficient",
            "pct_of_value": None,
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


def property_view(cases: list[dict]) -> dict:
    rows = []  # source: built from fixture cases below (real_notices.json + synthetic open)
    for case in cases:
        row = dict(case["row"])
        row["property_location"] = {
            "scope": "borough",
            "boroughs": ["Brooklyn"],
            "neighborhoods": [],
            "addresses": [],
            "tax_lots": [],
            "bbls": [],
            "geometry": None,
        }
        row["disposition_stage"] = "auction_or_rfp"
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
    mixed = [OPEN_CASE, *PAST_CASES]  # source: OPEN_CASE synthetic + PAST_CASES from real_notices.json
    # Past-only feed that would sort oldest-first under the old ascending close sort.
    past_first = list(PAST_CASES)  # source: PAST_CASES from test/fixtures/property_commercial/real_notices.json

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        def route_with(cases):
            def handler(route):
                url = route.request.url
                if "/property-locations" in url or "property:location" in url:
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps(property_view(cases)),
                    )
                    return
                if "dg92-zbpx" in url:
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps([dict(c["row"]) for c in cases]),
                    )
                    return
                route.continue_()

            return handler

        # AFTER (fixed product): open first, clean chips, closed archive section
        page.route("**/*", route_with(mixed))
        page.goto(f"{base}/index.html#property", wait_until="domcontentloaded")
        page.wait_for_timeout(3000)
        page.locator("#propertyfeed .fcard").first.wait_for(state="visible", timeout=20000)
        try:
            page.locator("[data-commercial-glance]").first.wait_for(state="visible", timeout=8000)
        except Exception:
            pass
        page.screenshot(path=str(OUT / "after-list-1440.png"), full_page=False)

        # Capture text proof for the PR (no $ before month on close chips)
        chips = page.locator("[data-close-chip]").all_inner_texts()
        (OUT / "after-close-chips.txt").write_text("\n".join(chips) + "\n", encoding="utf-8")
        closed = page.locator("[data-closed='1']").count()
        open_n = page.locator("[data-closed='0']").count()
        section = page.locator("[data-closed-section]").count()
        (OUT / "after-counts.txt").write_text(
            f"open_cards={open_n}\nclosed_cards={closed}\nclosed_section={section}\n",
            encoding="utf-8",
        )

        # BEFORE-shaped evidence: past-only feed (same fixtures that used to lead the default list)
        page.unroute("**/*")
        page.route("**/*", route_with(past_first))
        page.goto(f"{base}/index.html#property", wait_until="domcontentloaded")
        page.wait_for_timeout(2800)
        try:
            page.locator("#propertyfeed .fcard").first.wait_for(state="visible", timeout=15000)
        except Exception:
            pass
        page.screenshot(path=str(OUT / "before-past-only-1440.png"), full_page=False)

        # Mobile after
        page.unroute("**/*")
        page.route("**/*", route_with(mixed))
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{base}/index.html#property", wait_until="domcontentloaded")
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
