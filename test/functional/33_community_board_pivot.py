#!/usr/bin/env python3
"""Browser regression: CB10 pivots to its records and M10 includes its meetings."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000").rstrip("/")
BOARD_HREF = "/community-boards/manhattan-cb-10/"
ROOT = Path(__file__).resolve().parents[2]
MEETING_INDEX = json.loads(
    (ROOT / "site/data/community_board_meeting_index.json").read_text()
)
EXPECTED_CB10_MEETINGS = len(MEETING_INDEX["by_board"]["manhattan-cb-10"])


def main() -> None:
    assert EXPECTED_CB10_MEETINGS > 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()

        page.goto(f"{BASE}/browse/meetings/", wait_until="domcontentloaded", timeout=30000)
        pivot = page.locator(f'a[href="{BOARD_HREF}"]:visible').first
        pivot.wait_for(timeout=30000)
        pivot.click()
        page.wait_for_url(f"**{BOARD_HREF}", timeout=30000)

        profile = page.locator(
            'main[data-civic-object-kind="community-board-constellation"]'
            '[data-subject-ref="community-board:manhattan-cb-10"]'
        )
        profile.wait_for(timeout=30000)
        assert profile.locator(
            '[data-edge-type="hosts_meeting"][data-edge-state="matched"]'
        ).count() == 1
        assert profile.locator('[data-edge-type="has_member"]').count() == 1
        assert profile.locator('[data-edge-type="issues_recommendation"]').count() == 1

        query = urlencode({
            "v": "0",
            "lens": "meetings",
            "boro": "Manhattan",
            "cd": "M10",
            "level": "community_district",
            "id": "M10",
            "parent": "Manhattan",
        })
        page.goto(f"{BASE}/near-you/?{query}", wait_until="domcontentloaded", timeout=30000)
        results = page.locator(".near-results")
        results.wait_for(timeout=30000)
        board_meetings = results.locator(
            '.near-record[data-record-id^="meeting:community_board:'
            'https://cbmanhattan.cityofnewyork.us/cb10/"]'
        )
        board_meetings.first.wait_for(timeout=30000)
        assert board_meetings.count() == EXPECTED_CB10_MEETINGS
        assert board_meetings.locator(
            '.near-record-basis:has-text("matched by community board district")'
        ).count() == EXPECTED_CB10_MEETINGS

        browser.close()

    print("PASS: CB10 records pivot and ontology-derived M10 meetings")


if __name__ == "__main__":
    main()
