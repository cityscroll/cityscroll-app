#!/usr/bin/env python3
"""Capture focused Meetings card/detail evidence from a route-aware site origin."""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
from urllib.parse import quote

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "meeting-rendering-parity"
BOARD_MEETING_ID = (
    "meeting:community_board:https://cbmanhattan.cityofnewyork.us/cb10/event/"
    "committee-meeting-health-and-human-services-10-2-2-2-2-2/2026-08-17/"
)
DESIGN_MEETING_ID = "meeting:city_record:20260810053"
BASE_PLACEHOLDER = "__CITYSCROLL_CAPTURE_BASE__"


def route(base: str, path: str) -> str:
    return f"{base.rstrip('/')}/{path.lstrip('/')}"


def local_meeting_html(meeting_id: str) -> str:
    script = """
import fs from "node:fs";
import { renderMeetingDocument } from "./site/meeting_document.mjs";
const payload = JSON.parse(fs.readFileSync("./site/data/shared_meeting_read_model.json", "utf8"));
const record = payload.rows.find((row) => row.meeting_id === process.argv[1]);
if (!record) throw new Error(`meeting not found: ${process.argv[1]}`);
process.stdout.write(renderMeetingDocument(record));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script, meeting_id],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.replace("<head>", f'<head><base href="{BASE_PLACEHOLDER}">', 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, help="Route-aware CityScroll origin")
    parser.add_argument("--label", required=True, choices=("before", "after"))
    parser.add_argument("--local-render", action="store_true", help="Render meeting detail HTML from the local read model")
    args = parser.parse_args()

    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})

        page.goto(route(args.base, "/browse/meetings/"), wait_until="networkidle")
        card = page.locator("article.meetings-fcard", has_text="Health and Human Services").first
        card.wait_for(state="visible")
        if args.label == "after":
            host = card.locator("a.community-board-meeting-pivot", has_text="Hosted by Manhattan Community Board 10")
            assert host.count() == 1
            assert card.locator(".meetings-official-source", has_text="Community board source observed").count() == 1
            assert card.locator(".tag.source").count() == 0
            area = card.locator(".community-board-reference", has_text="manhattan-cb-10")
            assert area.get_attribute("href", timeout=5_000).startswith("/near-you/")
        card.screenshot(
            path=OUTPUT / f"{args.label}-community-board-card.png",
            animations="disabled",
        )

        if args.local_render:
            board_html = local_meeting_html(BOARD_MEETING_ID).replace(BASE_PLACEHOLDER, args.base.rstrip("/") + "/")
            page.set_content(board_html, wait_until="networkidle")
        else:
            page.goto(route(args.base, f"/meetings/{quote(BOARD_MEETING_ID, safe='')}"), wait_until="networkidle")
        detail = page.locator("main.meeting-document")
        detail.wait_for(state="visible")
        if args.label == "after":
            assert "upcoming_meetings" not in detail.inner_text()
            assert detail.get_by_text("Upcoming meeting", exact=True).count() == 1
        detail.screenshot(
            path=OUTPUT / f"{args.label}-community-board-detail.png",
            animations="disabled",
        )

        if args.local_render:
            design_html = local_meeting_html(DESIGN_MEETING_ID).replace(BASE_PLACEHOLDER, args.base.rstrip("/") + "/")
            page.set_content(design_html, wait_until="networkidle")
        else:
            page.goto(route(args.base, f"/meetings/{quote(DESIGN_MEETING_ID, safe='')}"), wait_until="networkidle")
        notice = page.locator(".meeting-notice-details")
        notice.wait_for(state="visible")
        if args.label == "after":
            assert "<p>" not in notice.inner_text()
            assert "Design Commission Meeting Agenda Monday, August 17, 2026" in notice.inner_text()
        notice.screenshot(
            path=OUTPUT / f"{args.label}-description.png",
            animations="disabled",
        )
        browser.close()

    for path in sorted(OUTPUT.glob(f"{args.label}-*.png")):
        print(f"{path.relative_to(ROOT)} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
