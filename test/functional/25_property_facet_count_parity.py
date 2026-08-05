#!/usr/bin/env python3
"""Property facet promises must equal the default scope each chip opens."""

from __future__ import annotations

from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, *_args):
        return

    def do_GET(self):  # noqa: N802
        if urlsplit(self.path).path.rstrip("/") == "/browse/property":
            original = self.path
            self.path = "/index.html"
            try:
                return super().do_GET()
            finally:
                self.path = original
        return super().do_GET()


def commercial(category: str, method: str | None = None, amount: int | None = None, deadline: str | None = None, eligible: bool = True) -> dict:
    price = None if amount is None else {
        "kind": "minimum_bid",
        "amount": amount,
        "display": f"${amount:,}",
        "source": "notice_body",
        "evidence": "Minimum bid",
        "confidence": "high",
    }
    events = [] if deadline is None else [{"kind": "bid_deadline", "deadline": deadline}]
    return {
        "schema": "cityscroll.property_commercial.v1",
        "disposition_class": "sale" if eligible else "destruction",
        "sale_eligible": eligible,
        "item": {"category": category, "label": category, "confidence": "high", "evidence": category, "source": "notice_body"},
        "quantities": [],
        "price_facts": [price] if price else [],
        "primary_price": price,
        "sale_method": {"method": method, "confidence": "high", "evidence": method} if method else None,
        "participation": {"package_url": None, "urls": [], "emails": [], "phones": [], "steps": [], "has_fields": False},
        "timed_events": events,
        "deal_signal": {"status": "insufficient", "summary": None, "comparables_slot": {"status": "not_yet_acquired", "category": category}},
        "close_date": deadline,
        "glance": {"item": category, "price": price, "close_date": deadline, "deal": None, "sale_method": method},
    }


def row(rid: str, category: str, *, action: bool = True, method: str | None = None, amount: int | None = None, event_date: str | None = None, process: str | None = None, notice_type: str = "Property Disposition") -> dict:
    body = "Inquiries relating to this property should be made to the Property Clerk."
    if method:
        body = f"Bids must be submitted by {event_date or 'December 31, 2099'}."
    if not action:
        body = "Official inventory record."
    return {
        "request_id": rid,
        "short_title": f"{category} fixture {rid}",
        "additional_description_1": body,
        "agency_name": "Test Agency",
        "type_of_notice_description": notice_type,
        "start_date": date.today().isoformat(),
        "event_date": event_date,
        "disposition_stage": process,
        "property_location": {"scope": "borough", "boroughs": ["Manhattan"], "neighborhoods": [], "addresses": [], "tax_lots": [], "bbls": [], "geometry": None},
        "commercial": commercial(category, method, amount, event_date, eligible=bool(method)),
    }


def fixture_rows() -> list[dict]:
    soon = (date.today() + timedelta(days=10)).isoformat()
    upcoming = (date.today() + timedelta(days=90)).isoformat()
    rows = [
        row("vehicle-current", "vehicle", method="online_auction", amount=5_000, event_date=upcoming, process="auction_or_rfp"),
        row("timber-current", "timber", method="public_auction", amount=50_000, event_date=upcoming, process="auction_or_rfp"),
        row("equipment-current", "equipment", method="sealed_bid", amount=500_000, event_date=soon, process="award_or_conveyance"),
        row("real-current", "real_property", method="rfp", amount=2_000_000, event_date=upcoming, process="hearing"),
        row("rights-current", "rights_and_interests", method="lease_auction", amount=75_000, event_date=upcoming),
        row("other-current", "other", event_date="2020-01-01", process="unstaged"),
        row("proposed-current", "real_property", event_date=None, process="hearing", notice_type="Public Hearings"),
        row("scrap-archive", "scrap_materials", action=False),
    ]
    rows.extend(row(f"seized-current-{index:02d}", "seized_property") for index in range(15))
    rows.extend(row(f"seized-archive-{index:02d}", "seized_property", action=False) for index in range(2))
    return rows


def payload(rows: list[dict]) -> dict:
    return {
        "schema_version": 1,
        "generated_at": f"{date.today().isoformat()}T12:00:00Z",
        "view": "list",
        "counts": {"total": len(rows), "local": len(rows), "unlocated": 0, "geometry": 0},
        "properties": rows,
        "disposition_spines": [],
    }


def count(text: str) -> int:
    match = re.search(r"\d+", text or "")
    assert match, f"missing count in {text!r}"
    return int(match.group())


def main() -> None:
    rows = fixture_rows()
    body = json.dumps(payload(rows))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
        errors: list[str] = list()

        def capture_pageerror(error) -> None:
            errors.append(str(error))
            print(f"PAGEERROR: {error}", flush=True)

        page.on("pageerror", capture_pageerror)

        def route(request):
            if "/property-locations" in request.request.url or "property:location" in request.request.url:
                request.fulfill(status=200, content_type="application/json", body=body)
                return
            if "dg92-zbpx" in request.request.url:
                request.fulfill(status=200, content_type="application/json", body=json.dumps(rows))
                return
            if request.request.url.endswith("/session"):
                request.fulfill(status=200, content_type="application/json", body='{"authenticated":false}')
                return
            if "/suggestions" in request.request.url:
                request.fulfill(status=200, content_type="application/json", body='{"suggestions":[]}')
                return
            if "cloudflareinsights.com/cdn-cgi/rum" in request.request.url:
                request.fulfill(status=204, body="")
                return
            request.continue_()

        page.route("**/*", route)
        page.goto(f"{base}/browse/property/?asset=seized_property", wait_until="domcontentloaded")
        try:
            page.wait_for_function("document.querySelector('#assettabs [data-a=seized_property].on') && document.querySelector('#property-count')?.textContent.includes('15')", timeout=30_000)
        except Exception:
            stop_point = page.evaluate("""() => ({
              href: location.href,
              assetHtml: document.querySelector('#assettabs')?.innerHTML,
              viewHtml: document.querySelector('#property-view-switch')?.innerHTML,
              countText: document.querySelector('#property-count')?.textContent,
              feedText: document.querySelector('#propertyfeed')?.textContent?.slice(0, 500),
              activeTab: document.querySelector('.tabbtn.active')?.dataset?.tab,
            })""")
            print(f"STOP_POINT: {json.dumps(stop_point, ensure_ascii=True)}", flush=True)
            raise
        assert not errors, errors
        assert count(page.locator('#assettabs [data-a="seized_property"] .ct').inner_text()) == 15
        assert count(page.locator('[data-property-view="default"] .ct').inner_text()) == 15
        assert count(page.locator('[data-property-view="archive"] .ct').inner_text()) == 2
        assert page.locator("#propertyfeed .fcard, #propertyfeed .property-cluster").count() > 0
        assert "Nothing found" not in page.locator("#propertyfeed").inner_text()

        rails = [
            ("#assettabs", "data-a"),
            ("#salerail", "data-m"),
            ("#pricerail", "data-p"),
            ("#liferail", "data-s"),
            ("#processrail", "data-p"),
        ]
        archive_case_seen = False
        for rail_selector, data_attr in rails:
            if rail_selector != "#assettabs" and page.locator("#property-more-filters").get_attribute("open") is None:
                page.locator("#property-more-filters > summary").click()
            keys = page.locator(f"{rail_selector} .chip").evaluate_all(f"buttons => buttons.map(button => button.getAttribute('{data_attr}'))")
            assert keys, f"no chips in {rail_selector}"
            for key in keys:
                chip = page.locator(f'{rail_selector} [{data_attr}="{key}"]')
                promised = count(chip.locator(".ct").inner_text())
                chip.click()
                page.wait_for_function(
                    "([rail, attr, key, promised]) => { const selected=document.querySelector(`${rail} [${attr}=\"${key}\"]`); const current=document.querySelector('[data-property-view=default] .ct'); const result=document.querySelector('#property-count'); return selected?.classList.contains('on') && Number(current?.textContent)===promised && Number((result?.textContent||'').match(/\\d+/)?.[0])===promised; }",
                    arg=[rail_selector, data_attr, key, promised],
                )
                assert count(page.locator("#property-count").inner_text()) == promised
                assert count(page.locator('[data-property-view="default"] .ct').inner_text()) == promised
                feed_text = page.locator("#propertyfeed").inner_text()
                assert "Nothing found" not in feed_text, f"generic search empty state after {rail_selector} {key}"

                archive_count = count(page.locator('[data-property-view="archive"] .ct').inner_text())
                if promised == 0 and archive_count > 0:
                    archive_case_seen = True
                    empty = page.locator("[data-property-scope-empty]")
                    assert empty.count() == 1
                    assert count(empty.locator("[data-property-scope-current-count]").inner_text()) == 0
                    assert count(empty.locator("[data-property-scope-archive-count]").inner_text()) == archive_count
                    empty.locator('[data-property-empty-view="archive"]').click()
                    page.wait_for_function(
                        "expected => document.querySelector('[data-property-view=archive]')?.getAttribute('aria-pressed')==='true' && Number((document.querySelector('#property-count')?.textContent||'').match(/\\d+/)?.[0])===expected",
                        arg=archive_count,
                    )
                    assert count(page.locator("#property-count").inner_text()) == archive_count
                    page.locator('[data-property-view="default"]').click()
                    page.wait_for_function("document.querySelector('[data-property-view=default]')?.getAttribute('aria-pressed')==='true'")

                reset = page.locator(f'{rail_selector} [{data_attr}="all"]')
                reset.click()
                page.wait_for_function(
                    "([rail, attr]) => document.querySelector(`${rail} [${attr}=\"all\"]`)?.classList.contains('on')",
                    arg=[rail_selector, data_attr],
                )

        assert archive_case_seen, "fixture did not exercise the archive affordance"
        assert not errors, errors
        browser.close()

    server.shutdown()
    print("PASS: every Property facet chip matches its default scope, including archive-only scopes")


if __name__ == "__main__":
    main()
