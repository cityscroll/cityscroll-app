"""Drive the homepage's plain-English Preview through the application graph."""

from __future__ import annotations

import json
import os
from urllib.parse import urlparse

from playwright.sync_api import Page, Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

PREVIEW_ROWS = [
    {
        "request_id": f"preview-{index}",
        "start_date": "2026-08-01",
        "agency_name": "Design and Construction",
        "type_of_notice_description": "Solicitation",
        "category_description": "Construction/Construction Services",
        "short_title": f"Construction mosquito zoning services project {index}",
        "pin": f"PREVIEW-{index}",
        "due_date": f"2099-08-{20 + index:02d}T16:00:00.000",
        "selection_method_description": "Competitive Sealed Proposals",
        "contract_amount": "250000",
        "vendor_name": "Preview Services LLC",
    }
    for index in range(1, 5)
]


def json_response(route: Route, body: object, *, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
        body=json.dumps(body),
    )


def install_routes(page: Page, *, snapshot_status: int = 200) -> None:
    def worker(route: Route) -> None:
        if urlparse(route.request.url).path == "/nl":
            request = json.loads(route.request.post_data or "{}")
            json_response(route, {"filter": {"keywords": [request.get("text", "")]}, "degraded": False})
            return
        json_response(route, {"ok": False}, status=503)

    def snapshot(route: Route) -> None:
        json_response(route, {"schema_version": 1, "count": len(PREVIEW_ROWS), "rows": PREVIEW_ROWS}, status=snapshot_status)

    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)
    page.route("**/data/money_default_open.json", snapshot)
    page.route("**/data/money_resident_snapshot.json", snapshot)


def drive_preview(page: Page, topic: str, trigger: str) -> str:
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("details.ask-cityscroll summary").click()
    page.locator("#nlq").fill(topic)
    if trigger == "click":
        page.locator("#nlgo").click()
    else:
        page.locator("#nlq").press("Enter")
    page.locator("#nltrans [data-preview-state]").wait_for(state="visible", timeout=30_000)
    return page.locator("#nltrans").inner_text()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()

    for topic, trigger in (("mosquito", "click"), ("zoning", "enter")):
        page = context.new_page()
        install_routes(page)
        if os.environ.get("CROL_CAPTURE_SHOTS"):
            width, height = (390, 844) if trigger == "click" else (1440, 900)
            page.set_viewport_size({"width": width, "height": height})
        text = drive_preview(page, topic, trigger)
        assert page.locator('#nltrans [data-preview-state="results"]').count() == 1, (topic, trigger, text)
        assert page.locator("#nltrans .money-row-card").count() == 3, (topic, trigger, text)
        assert "Showing the first 3 matching records." in text, (topic, trigger, text)
        if os.environ.get("CROL_CAPTURE_SHOTS"):
            page.locator("#nltrans").scroll_into_view_if_needed()
            page.screenshot(
                path=f"docs/screenshots/plain-english-preview/after-{390 if trigger == 'click' else 1440}.png",
                animations="disabled",
            )
        page.close()

    page = context.new_page()
    install_routes(page, snapshot_status=503)
    text = drive_preview(page, "mosquito", "click")
    assert page.locator('#nltrans [data-preview-state="error"]').count() == 1, text
    assert text.strip(), "Preview failures must render an explicit state"
    page.close()
    browser.close()

print("PASS: homepage Preview renders bounded results for click and Enter, and surfaces source errors")
