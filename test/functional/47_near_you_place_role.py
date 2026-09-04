#!/usr/bin/env python3
"""Browser regression (PS-02 acceptance A9): a place-role refinement selected on Near You
survives switching between the Records and Map view and reloading, without losing the
place or any other active filter.
"""

from __future__ import annotations

import os
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://localhost:8000").rstrip("/")


def query(page: Page) -> dict:
    return parse_qs(urlparse(page.url).query)


def assert_journey(page: Page) -> None:
    # 1. Select a place.
    page.goto(f"{BASE}/near-you/", wait_until="networkidle")
    page.locator('#near-place-fields select[name="boro"]').select_option("Brooklyn")
    page.locator('#near-place-fields button[type="submit"]').click()
    page.wait_for_load_state("networkidle")
    assert query(page).get("boro") == ["Brooklyn"], "borough did not survive the place selection"

    # 2. Select "Affecting this place" — a refinement of the same place scope, not a new page.
    role_select = page.locator('#near-place-fields select[name="placeRole"]')
    assert role_select.count() == 1, "the place-role selector is missing for the meetings lens"
    role_select.select_option("affected_area")
    page.locator('#near-place-fields button[type="submit"]').click()
    page.wait_for_load_state("networkidle")
    params = query(page)
    assert params.get("boro") == ["Brooklyn"], "the place was lost when the role was applied"
    assert params.get("placeRole") == ["affected_area"], "the role choice did not reach the URL"

    # 3. Inspect results: the active-filters chip list names the role in plain language, and
    # the role selector reflects the choice on reload.
    scope_chips = page.locator("[data-scope-axis='local activity']")
    assert scope_chips.count() == 1, "no active-filter chip named the selected role"
    assert scope_chips.first.inner_text().strip() == "Affecting this place"
    assert role_select.input_value() == "affected_area"

    before_url = page.url

    # 4. Switch view (Records -> Map). This is a client-side toggle: the URL, and so the
    # scope it encodes, must not change.
    page.locator('[data-near-surface="map"]').click()
    assert page.locator('[data-near-surface="map"]').get_attribute("aria-current") == "true"
    assert page.url == before_url, "switching to the map view changed the scope-bearing URL"

    # 5. Return to the Records view.
    page.locator('[data-near-surface="list"]').click()
    assert page.locator('[data-near-surface="list"]').get_attribute("aria-current") == "true"
    assert page.url == before_url, "returning to the records view changed the scope-bearing URL"

    # 6. A hard reload of the same URL reconstructs the exact same scope (A2: reload-safe).
    page.goto(before_url, wait_until="networkidle")
    reloaded_params = query(page)
    assert reloaded_params.get("boro") == ["Brooklyn"]
    assert reloaded_params.get("placeRole") == ["affected_area"]
    assert page.locator('#near-place-fields select[name="placeRole"]').input_value() == "affected_area"
    assert page.locator("[data-scope-axis='local activity']").first.inner_text().strip() == "Affecting this place"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        assert_journey(page)
        browser.close()

    print("PASS: Near-you place-role refinement survives the view switch and a reload")


if __name__ == "__main__":
    main()
