"""Drive the homepage's plain-English Preview through the application graph."""

from __future__ import annotations

import json
import os
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

def preview_results(query: str) -> list[dict[str, object]]:
    return [
        {
            "schema": "cityscroll.search_document.v1",
            "result_schema": "cityscroll.universal_search_result.v1",
            "outcome": "indexed",
            "object_ref": f"meeting:preview-{index}",
            "object_type": "meeting",
            "entity_type": "meeting",
            "domain": "meetings",
            "lens": "meetings",
            "canonical_href": f"/meetings/meeting%3Apreview-{index}",
            "source_route": f"/meetings/meeting%3Apreview-{index}",
            "title": f"{query} public meeting {index}",
            "summary": f"Published {query} record.",
            "search_text": f"{query} public meeting {index}",
            "source_observation_refs": [f"preview:meeting-{index}"],
            "provenance": {"producer": "functional_fixture.v1", "lifecycle": {"state": "scheduled"}},
            "match_fields": [{
                "field": "title",
                "matched_term": query,
                "source_observation_ref": f"preview:meeting-{index}",
            }],
            "match_evidence": {
                "field": "title",
                "matched_normalized_term": query,
                "source_identifier": f"preview:meeting-{index}",
                "snippet": {"text": f"{query} public meeting {index}", "mark_start": 0, "mark_end": len(query)},
            },
            "ranking": {"lifecycle_state": "scheduled"},
        }
        for index in range(1, 4)
    ]


def json_response(route: Route, body: object, *, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
        body=json.dumps(body),
    )


def install_routes(page: Page, *, search_status: int = 200) -> None:
    def worker(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path == "/nl":
            request = json.loads(route.request.post_data or "{}")
            json_response(route, {"filter": {"keywords": [request.get("text", "")]}, "degraded": False})
            return
        if path == "/search":
            query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0]
            json_response(route, {"results": preview_results(query)}, status=search_status)
            return
        json_response(route, {"ok": False}, status=503)

    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://cityscroll-worker.crol-worker.workers.dev/**", worker)


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

    for topic, trigger in (("mosquito", "click"), ("zoning", "enter"), ("rezoning", "click")):
        page = context.new_page()
        install_routes(page)
        if os.environ.get("CROL_CAPTURE_SHOTS"):
            width, height = (390, 844) if trigger == "click" else (1440, 900)
            page.set_viewport_size({"width": width, "height": height})
        text = drive_preview(page, topic, trigger)
        assert page.locator('#nltrans [data-preview-state="results"]').count() == 1, (topic, trigger, text)
        assert page.locator("#nltrans .topic-search-result").count() == 3, (topic, trigger, text)
        assert page.locator("#nltrans .money-row-card").count() == 0, (topic, trigger, text)
        assert "No matches in this bounded source set" not in text, (topic, trigger, text)
        assert "Showing the first 3 matching records." in text, (topic, trigger, text)
        if os.environ.get("CROL_CAPTURE_SHOTS"):
            page.locator("#nltrans").scroll_into_view_if_needed()
            page.screenshot(
                path=f"docs/screenshots/plain-english-preview/after-{390 if trigger == 'click' else 1440}.png",
                animations="disabled",
            )
        page.close()

    page = context.new_page()
    install_routes(page, search_status=503)
    text = drive_preview(page, "mosquito", "click")
    assert page.locator('#nltrans [data-preview-state="error"]').count() == 1, text
    assert text.strip(), "Preview failures must render an explicit state"
    page.close()
    browser.close()

print("PASS: homepage Preview renders bounded results for click and Enter, and surfaces source errors")
