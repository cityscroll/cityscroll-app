"""Keep Meetings keyword filtering and Ask composition additive on the real route."""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent / "assets"))
from ci_waits import wait_for_function


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/")


def meeting(day: datetime, *, request_id: str, title: str, description: str, borough: str):
    return {
        "meeting_id": f"meeting:city_record:{request_id}",
        "source_system": "city_record",
        "meeting_origin": "city_record",
        "request_id": request_id,
        "short_title": title,
        "additional_description_1": description,
        "agency_name": "Department of Test Meetings",
        "event_date": day.isoformat(),
        "affected_area": {"scope": "local", "boroughs": [borough]},
        "participation": {},
        "venue": {"address": "1 Centre Street"},
    }


def main():
    now = datetime.now(UTC)
    payload = {
        "schema": "cityscroll.shared_meeting_read_model.v1",
        "version": 1,
        "rows": [
            meeting(
                now + timedelta(days=1),
                request_id="recycling",
                title="Neighborhood recycling hearing",
                description="Curbside recycling changes for Queens residents.",
                borough="Queens",
            ),
            meeting(
                now + timedelta(days=2),
                request_id="libraries",
                title="Public library budget hearing",
                description="Library service plans for Queens residents.",
                borough="Queens",
            ),
            meeting(
                now + timedelta(days=3),
                request_id="parks",
                title="Public parks planning hearing",
                description="Playground plans for Brooklyn residents.",
                borough="Brooklyn",
            ),
        ],
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.route(
            "**/data/shared_meeting_read_model.json",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(payload),
            ),
        )
        # Exercise the shipped on-device Ask path without depending on a live Worker.
        page.route("**/nl", lambda route: route.fulfill(status=503, body="unavailable"))

        page.goto(
            BASE.rstrip("/") + "/browse/meetings/",
            wait_until="domcontentloaded",
            timeout=30_000,
        )
        wait_for_function(
            page,
            "document.querySelectorAll('#meetingsfeed .meetings-fcard').length === 3",
            label="initial Meetings rows",
        )

        # The existing place facet stays active while the keyword narrows actual row text.
        page.locator("#meetings-more-filters summary").click()
        page.locator("#meetingsboro").select_option("Queens")
        wait_for_function(
            page,
            "document.querySelectorAll('#meetingsfeed .meetings-fcard').length === 2",
            label="Queens Meetings facet",
        )
        page.locator("#meetingskw").fill("recycling")
        page.locator("#meetingskw").press("Enter")
        wait_for_function(
            page,
            """() => {
                const cards = [...document.querySelectorAll('#meetingsfeed .meetings-fcard')];
                return cards.length === 1
                    && cards[0].textContent.toLowerCase().includes('recycling');
            }""",
            label="Meetings keyword match",
        )

        # Ask adds a time clause through the real Meetings path; it does not replace
        # the standard keyword or the existing place facet.
        page.locator("#meetings-more-filters summary").click()
        page.locator('[data-ask-lens="meetings"] summary').click()
        page.locator("#nlq-meetings").fill("next 30 days")
        page.locator("#nlgo-meetings").click()
        wait_for_function(
            page,
            """() => document.querySelector('#meetingswhen')?.value === 'month'
                && document.querySelector('#meetingskw')?.value === 'recycling'
                && document.querySelector('#meetingsboro')?.value === 'Queens'
                && document.querySelectorAll('#meetingsfeed .meetings-fcard').length === 1""",
            label="additive Meetings Ask composition",
        )

        interpreted = page.locator('[data-search-state="meetings"]').inner_text()
        assert "recycling" in interpreted.lower(), interpreted
        assert "30" in interpreted, interpreted
        assert page.locator('[data-ask-lens="meetings"]').is_visible()
        browser.close()

    print("PASS: Meetings keyword filter and Ask compose remain additive")


if __name__ == "__main__":
    main()
