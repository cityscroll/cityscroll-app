"""Headless route contracts for first-hop and multi-hop traversal back controls."""

import base64
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000").rstrip("/")
SHOT = Path(os.environ.get("CROL_SHOTS", Path(__file__).parent / "shots"))
SHOT.mkdir(parents=True, exist_ok=True)


def token(hops):
    state = {"schema": "cityscroll.traversal.v1", "version": 1, "status": "active", "hops": hops}
    encoded = base64.urlsafe_b64encode(json.dumps(state, separators=(",", ":")).encode()).decode().rstrip("=")
    return encoded


ORIGIN = {"kind": "agency", "id": "parks-and-recreation", "name": "Parks and Recreation", "href": "/agencies/parks-and-recreation/"}
NOTICE = {"kind": "notice", "id": "20240515016", "name": "Forest management", "href": "/notices/20240515016"}
OFFICIAL = {"kind": "official", "id": "7801", "name": "Official One", "href": "/officials/7801/"}


def main():
    first = token([{"source": ORIGIN, "relation": "hosted meeting", "destination": NOTICE}])
    multi = token([
        {"source": ORIGIN, "relation": "hosted meeting", "destination": NOTICE},
        {"source": NOTICE, "relation": "named official", "destination": OFFICIAL},
    ])
    row = {
        "request_id": NOTICE["id"],
        "short_title": NOTICE["name"],
        "agency_name": "Parks & Recreation",
        "type_of_notice_description": "Solicitation",
        "section_name": "Procurement",
        "additional_description_1": "Public notice text",
    }

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.route("**/notice?id=*", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"row": row})))
        page.route("**/hearings?id=*", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"hearings": []})))
        page.route("**/attachment-metadata*", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"attachments": []})))

        page.goto(f"{BASE}/notices/{NOTICE['id']}?walk={first}", wait_until="domcontentloaded")
        page.locator("#noticeview .route-item").wait_for(timeout=30000)
        back = page.locator("#noticeview a[data-route-back]").first
        assert back.get_attribute("data-route-back") == "traversal"
        assert back.get_attribute("href") == ORIGIN["href"]
        assert page.locator(".traversal-path").count() == 1
        page.screenshot(path=str(SHOT / "traversal-walk-after-first-hop.png"), full_page=True)

        page.goto(f"{BASE}/officials/{OFFICIAL['id']}/?walk={multi}", wait_until="domcontentloaded")
        page.locator(".traversal-path").wait_for(timeout=30000)
        back = page.locator(".traversal-path-back").first
        href = back.get_attribute("href") or ""
        assert "/notices/20240515016" in href
        assert "walk=" in href
        page.screenshot(path=str(SHOT / "traversal-walk-after-multi-hop.png"), full_page=True)
        browser.close()


if __name__ == "__main__":
    main()
