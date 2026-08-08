"""Follow agency Browse links through SPA hydration and reject false scopes."""

import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/")
TARGET_REF = "agency:id:citywide-administrative-services"


def fixture_payloads():
    with (ROOT / "site" / "data" / "entity_intelligence_lookup.json").open(encoding="utf-8") as handle:
        entity_lookup = json.load(handle)
    with (ROOT / "site" / "data" / "meetings_domain_observations.json").open(encoding="utf-8") as handle:
        meetings = json.load(handle)["rows"]
    hearings = [
        {
            "request_id": row["request_id"],
            "agency": row["agency_name"],
            "title": row.get("short_title"),
            "event_date": row.get("event_date"),
            "affected_area": row.get("affected_area") or {"scope": "unlocated"},
        }
        for row in meetings
    ]
    return entity_lookup["by_ref"][TARGET_REF], {"hearings": hearings}, len(hearings)


def main():
    agency_response, hearings_response, all_count = fixture_payloads()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.route(
            "**/entity-intelligence?*",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(agency_response),
            ),
        )
        page.route(
            "**/hearings*",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(hearings_response),
            ),
        )

        # Interactive SPA agency profile (entity-intelligence scope links).
        # Bare /agencies/<id>/ serves the static constellation document.
        page.goto(
            BASE.rstrip("/") + "/agencies/citywide-administrative-services/?tab=overview",
            wait_until="domcontentloaded",
            timeout=30000,
        )
        page.wait_for_selector("#entityview .agencybar", timeout=45000)
        links = page.evaluate(
            """[...document.querySelectorAll('#entity-intelligence a.ei-view-all')]
            .map(a => a.getAttribute('href')).filter(Boolean)"""
        )
        # Source: agency profile links rendered by site/agency_connections.mjs.
        meeting_links = [href for href in links if "/browse/meetings/" in href]  # noqa: source-backed route
        assert meeting_links, "the agency profile must expose its Meetings scope link"

        page.goto(BASE.rstrip("/") + meeting_links[0], wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function(
            "document.querySelector('#tab-meetings')?.classList.contains('active')",
            timeout=30000,
        )
        page.wait_for_function(
            "Array.isArray(window.feedVisible?.meetings) && window.feedVisible.meetings.length > 0",
            timeout=45000,
        )
        state = page.evaluate(
            """(() => ({
              rows: (window.feedVisible.meetings || []).map(row => row.agency_name),
              count: (window.feedVisible.meetings || []).length,
              refs: JSON.parse(new URL(location.href).searchParams.get('facet') || '{}').entity_refs_all || [],
            }))()"""
        )
        assert TARGET_REF in state["refs"], state
        assert 0 < state["count"] < all_count, state
        assert all(name == "Citywide Administrative Services" for name in state["rows"]), state
        print("PASS: agency Meetings scope survives SPA hydration", state)
        browser.close()


if __name__ == "__main__":
    main()
