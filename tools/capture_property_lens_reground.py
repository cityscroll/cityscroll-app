#!/usr/bin/env python3
"""Before/after capture for the Property lens re-grounding (docs/design-principles-lens.md).

Runs the SAME mocked dataset through whichever build is checked out, so the only
difference between before/after is the code. Label + output dir are env-driven so the
same script can be run in a base checkout (label=before) and this branch (label=after),
both writing into one screenshots dir.

Env:
  CROL_REGROUND_LABEL   "before" | "after"  (default "after")
  CROL_REGROUND_OUT     output dir           (default docs/screenshots/property-lens-reground)

Scenarios:
  default        current sales lead; archive with 5 near-identical destruction notices
  empty-current  ONLY the 5 closed destruction notices (the owner's screenshot symptom)
after-only shots also open "More filters" (capability parity) and expand the cluster.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LABEL = os.environ.get("CROL_REGROUND_LABEL", "after")
OUT = Path(os.environ.get("CROL_REGROUND_OUT", str(ROOT / "docs" / "screenshots" / "property-lens-reground")))

BORO = {"scope": "borough", "boroughs": ["Manhattan"], "neighborhoods": [], "addresses": [], "tax_lots": [], "bbls": [], "geometry": None}


def commercial(category, method, close, price=None, deal=None, amount=None, eligible=True):
    primary = None
    if amount is not None and price:
        primary = {"kind": price["kind"], "amount": amount, "display": price["display"],
                   "source": "notice_body", "evidence": "fixture", "confidence": "high"}
    return {
        "schema": "cityscroll.property_commercial.v1",
        "disposition_class": "sale" if eligible else "destruction",
        "sale_eligible": eligible,
        "item": {"category": category, "confidence": "high", "evidence": "fixture", "source": "notice_body"},
        "quantities": [], "price_facts": [primary] if primary else [], "primary_price": primary,
        "sale_method": {"method": method, "confidence": "high", "evidence": "fixture"} if method else None,
        "participation": {"package_url": None, "urls": [], "emails": [], "phones": [], "steps": [], "has_fields": False},
        "deal_signal": {"status": "derived" if deal else "insufficient", "pct_of_value": 40 if deal else None,
                        "summary": deal, "method": "stated_value_discount",
                        "comparables_slot": {"status": "not_yet_acquired", "category": category}},
        "close_date": close,
        "glance": {"item": None, "price": price, "close_date": close, "deal": deal, "sale_method": method},
    }


def row(rid, title, agency, ntype, date, stage, com=None):
    r = {
        "request_id": rid, "short_title": title, "agency_name": agency,
        "type_of_notice_description": ntype, "event_date": date, "start_date": date,
        "additional_description_1": title, "property_location": dict(BORO), "disposition_stage": stage,
    }
    if com:
        r["commercial"] = com
    return r


# Three CURRENT sales (future close) + five near-identical CLOSED destruction notices (past).
CURRENT = [
    row("open-vehicle-01", "Auction of surplus fleet vehicles", "Department of Citywide Administrative Services",
        "Solicitation", "2026-09-18", "auction_or_rfp",
        commercial("vehicle", "online_auction", "2026-09-18",
                   price={"kind": "minimum_bid", "display": "$4,800"}, amount=4800,
                   deal="Minimum bid is 40% of stated appraised value")),
    row("open-realty-01", "Request for proposals: redevelopment of city-owned parcel", "Department of Housing Preservation and Development",
        "Solicitation", "2026-10-02", "auction_or_rfp",
        commercial("real_property", "rfp", "2026-10-02",
                   price={"kind": "upset_price", "display": "$1,250,000"}, amount=1250000)),
    row("open-equip-01", "Public auction of surplus heavy equipment", "Department of Sanitation",
        "Solicitation", "2026-09-30", "auction_or_rfp",
        commercial("equipment", "public_auction", "2026-09-30",
                   price={"kind": "upset_price", "display": "$25,000"}, amount=25000)),
]
DESTRUCTION = [
    row(f"destroy-24{n:02d}", f"Property clerk invoice 24{n:02d} pending destruction of unclaimed property",
        "Police Department", "Public Hearings", d, "auction_or_rfp",
        commercial("other", None, d, eligible=False))
    for n, d in [(1, "2026-01-10"), (2, "2026-02-14"), (3, "2026-03-11"), (4, "2026-04-08"), (5, "2026-05-01")]
]


def view(rows):
    return {
        "schema_version": 1, "generated_at": "2026-08-03T12:00:00.000Z", "view": "list",
        "source": {"name": "City Record Online", "dataset": "dg92-zbpx"},
        "counts": {"total": len(rows), "local": 0, "unlocated": 0, "geometry": 0},
        "properties": rows, "disposition_spines": [],
        "commercial_metrics": {"metric": "property_commercial_price_coverage", "n": len(rows)},
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT / "site"), **k)

    def log_message(self, *a):  # noqa: A003
        return


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    rows_ref = {"rows": CURRENT + DESTRUCTION}

    def route(r):
        url = r.request.url
        if "/property-locations" in url or "property:location" in url:
            r.fulfill(status=200, content_type="application/json", body=json.dumps(view(rows_ref["rows"])))
            return
        if "dg92-zbpx" in url:
            r.fulfill(status=200, content_type="application/json", body=json.dumps(rows_ref["rows"]))
            return
        r.continue_()

    def wait_feed(page):
        page.wait_for_timeout(2600)
        try:
            page.locator("#propertyfeed .fcard, #propertyfeed .property-cluster, #propertyfeed .property-empty-current").first.wait_for(state="visible", timeout=20000)
        except Exception:
            pass

    with sync_playwright() as p:
        browser = p.chromium.launch()

        def shot(rows, out_name, width=1440, height=1000, click=None):
            # Fresh context per scenario so the client's in-memory data cache does not
            # carry a prior dataset across navigations.
            rows_ref["rows"] = rows
            ctx = browser.new_context(viewport={"width": width, "height": height})
            ctx.route("**/*", route)
            page = ctx.new_page()
            page.goto(f"{base}/index.html#property", wait_until="domcontentloaded")
            wait_feed(page)
            if click:
                try:
                    page.locator(click).first.click(timeout=4000)
                    page.wait_for_timeout(500)
                except Exception:
                    pass
            page.screenshot(path=str(OUT / out_name), full_page=True)
            ctx.close()

        # Scenario A — default list (current leads, archive with the repeats)
        shot(CURRENT + DESTRUCTION, f"{LABEL}-default-1440.png")
        shot(CURRENT + DESTRUCTION, f"{LABEL}-default-390.png", width=390, height=844)
        # Scenario B — only closed destruction notices (empty-current symptom)
        shot(list(DESTRUCTION), f"{LABEL}-empty-current-1440.png")

        if LABEL == "after":
            # Capability parity: open "More filters" to show every secondary facet is reachable.
            shot(CURRENT + DESTRUCTION, "after-morefilters-1440.png", click="#property-more-filters > summary")
            # Honest expandable collapse: expand the cluster card.
            shot(list(DESTRUCTION), "after-cluster-expanded-1440.png", click=".property-cluster > details > summary")

        browser.close()
    server.shutdown()
    print(f"wrote {LABEL} screenshots under {OUT}")


if __name__ == "__main__":
    main()
