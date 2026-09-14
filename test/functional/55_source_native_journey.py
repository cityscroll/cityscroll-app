#!/usr/bin/env python3
"""Read back the source-native meeting journey on served routes.

The receipt is deliberately textual: captures are identified by route,
viewport, revision, data vintage, assertion, and a rendered-content hash.
Images are not evidence for this journey.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import date
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000").rstrip("/")
BOARD = "/community-boards/brooklyn-cb-15/"
MEETING_TOKEN = "2026-09-29"
OFFICIAL_SOURCE = "https://www.nyc.gov/site/brooklyncb15/calendar/calendar.page"
MANIFEST = ROOT / "docs/evidence/community-board-source-native-journey/capture-manifest.json"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def record(entries, *, case, route, viewport, assertion, page, passed=True):
    entries.append({
        "case": case,
        "route": route,
        "viewport": {"width": viewport[0], "height": viewport[1]},
        "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "data_vintage": "served route read-back on 2026-09-14",
        "assertion": assertion,
        "render_sha256": digest(page.locator("body").inner_text()),
        "passed": passed,
    })


def main() -> None:
    entries = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for viewport in ((1440, 900), (390, 844)):
            page = browser.new_page(viewport={"width": viewport[0], "height": viewport[1]})
            page.goto(urljoin(BASE + "/", BOARD.lstrip("/")), wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_selector("main", state="attached")

            # A5 journey letter 1: the board publishes the exact event preview.
            preview = page.locator(f'a[href*="{MEETING_TOKEN}"]').first
            assert preview.count() == 1, "CB15 board does not expose the retained event identity"
            event_href = preview.get_attribute("href")
            assert event_href and event_href.startswith("/meetings/")
            record(entries, case=f"board-to-event-preview-{viewport[0]}x{viewport[1]}", route=BOARD,
                   viewport=viewport, assertion="board publishes the retained September 29 event identity as a canonical preview link", page=page)

            # A5 journey letter 2: the preview identity resolves to canonical detail.
            page.goto(urljoin(BASE + "/", event_href.lstrip("/")), wait_until="domcontentloaded", timeout=60_000)
            assert page.locator("main").count() == 1
            body = page.locator("body").inner_text()
            assert "General Board Meeting" in body
            assert "September 29, 2026" in body
            assert "Kingsborough Community College" in body
            record(entries, case=f"event-preview-to-detail-{viewport[0]}x{viewport[1]}", route=event_href,
                   viewport=viewport, assertion="the canonical event identity resolves to detail with the published title, date, and room", page=page)

            # A5 journey letter 3: detail retains the publisher's official source.
            source = page.locator(f'a[href="{OFFICIAL_SOURCE}"]').first
            assert source.count() == 1
            record(entries, case=f"detail-to-official-source-{viewport[0]}x{viewport[1]}", route=event_href,
                   viewport=viewport, assertion="canonical detail retains the exact official calendar destination", page=page)

            # A5 journey letter 4: browser Back returns to the same canonical detail.
            detail_url = page.url
            source.click()
            page.wait_for_load_state("domcontentloaded", timeout=60_000)
            assert page.url == OFFICIAL_SOURCE
            page.go_back(wait_until="domcontentloaded", timeout=60_000)
            assert page.url == detail_url
            assert page.locator("h1").inner_text() == "General Board Meeting (In Person)"
            record(entries, case=f"official-source-back-to-detail-{viewport[0]}x{viewport[1]}", route=event_href,
                   viewport=viewport, assertion="opening the official source and pressing browser Back returns to the same canonical detail", page=page)
            page.close()
        browser.close()

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps({
        "schema": "cityscroll.community_board_source_native_journey_manifest.v1",
        "repository_revision": entries[0]["revision"],
        "read_on": date.today().isoformat(),
        "data_vintage": "served route read-back on 2026-09-14",
        "route_base": BASE,
        "source_url": OFFICIAL_SOURCE,
        "assertions": entries,
    }, indent=2) + "\n")
    print(f"PASS: {len(entries)} source-native journey assertions")


if __name__ == "__main__":
    main()
