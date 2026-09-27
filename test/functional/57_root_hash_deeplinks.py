#!/usr/bin/env python3
"""Root hash ingress reaches every route family registered by the topic SPA."""

from __future__ import annotations

import os
import pathlib
import sys

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


BASE = os.environ.get("CROL_BASE", "http://localhost:8000/").rstrip("/") + "/"

# One representative per registry entry. The equality assertion below makes a
# newly registered route fail this census until it has a real browser specimen.
CASES = {
    "browse": ("browse", "#tab-browse.active"),
    "money": ("money", "#tab-money.active"),
    "staffing": ("staffing", "#tab-staffing.active"),
    "exams": ("exams", "#tab-exams.active"),
    "land": ("land", "#tab-land.active"),
    "property": ("property", "#tab-property.active"),
    "rules": ("rules", "#tab-rules.active"),
    "meetings": ("meetings", "#tab-meetings.active"),
    "now": ("now", "#tab-now.active"),
    "map": ("map", "[data-near-you-root]"),
    "alerts": ("alerts", "[data-following-root]"),
    "notice-item": ("notice/20260701099", "#tab-notice.active"),
    "land-item": ("land/2022M0258", "#land-item-card"),
    "exam-item": ("exam/7016", '[data-exam-document="1"]'),
    "vendor": ("vendor/CAMBA", "#tab-entity.active"),
    "agency": (
        "agency/Housing%20Preservation%20and%20Development",
        '[data-civic-object-kind="agency-constellation"], #tab-entity.active',
    ),
    "official": ("official/7801", "#official-skim"),
    "matter": ("matter/84124P0003001", "#tab-entity.active"),
    "investigation-signal": (
        "investigation/signal/root-hash-census-missing",
        "#inv-empty-guide",
    ),
    "investigation-shared": (
        "investigation/shared/root-hash-census-missing",
        "#tab-entity.active",
    ),
    "task": ("task/can-i-bid", "#tab-task.active #taskview"),
    "investigation": ("investigation", "#inv-empty-guide"),
    "notice-collection": ("notice", "#tab-money.active"),
    "exam-collection": ("exam", "#tab-exams.active"),
    "vendor-collection": ("vendor", "#tab-money.active"),
    "agency-collection": ("agency", "#tab-money.active"),
    "matter-collection": ("matter", "#tab-money.active"),
    "investigation-shared-collection": (
        "investigation/shared",
        "#inv-empty-guide",
    ),
    "task-collection": ("task", "#tab-money.active"),
}


def new_page(browser):
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    install_routes(page)
    return page


def registered_route_ids(browser) -> list[str]:
    page = new_page(browser)
    try:
        page.goto(f"{BASE}index.html#browse", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_function(
            "() => document.body.dataset.appReady === 'true' && Array.isArray(globalThis.CrolSpaHashRoutes)",
            timeout=60_000,
        )
        return page.evaluate("globalThis.CrolSpaHashRoutes.map(route => route.id)")
    finally:
        page.close()


def assert_route(browser, route_id: str, fragment: str, selector: str) -> None:
    page = new_page(browser)
    try:
        page.goto(f"{BASE}#{fragment}", wait_until="domcontentloaded", timeout=60_000)
        try:
            page.locator(selector).first.wait_for(state="visible", timeout=60_000)
        except PlaywrightTimeoutError as error:
            raise AssertionError(
                f"{route_id} did not reach {selector} via /#{fragment}: {page.url}"
            ) from error
    finally:
        page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        route_ids = registered_route_ids(browser)
        assert len(route_ids) == len(set(route_ids)), f"duplicate SPA route ids: {route_ids}"
        assert set(route_ids) == set(CASES), (
            f"root hash census does not match router registry; "
            f"missing={sorted(set(route_ids) - set(CASES))} "
            f"stale={sorted(set(CASES) - set(route_ids))}"
        )

        for route_id in route_ids:
            assert_route(browser, route_id, *CASES[route_id])

        bare = new_page(browser)
        bare.goto(BASE, wait_until="domcontentloaded", timeout=60_000)
        bare.locator("[data-near-you-root]").wait_for(state="visible", timeout=30_000)
        assert "Near you" in bare.title()
        bare.close()

        unknown = new_page(browser)
        unknown.goto(f"{BASE}#not-a-cityscroll-route", wait_until="domcontentloaded", timeout=60_000)
        unknown.locator("[data-near-you-root]").wait_for(state="visible", timeout=30_000)
        assert unknown.url.endswith("/#not-a-cityscroll-route"), unknown.url
        unknown.close()

        # Positive control: turning off the new retained-hash boot branch must
        # reproduce the Land-item failure on the Near You root document.
        control = new_page(browser)
        control.add_init_script("globalThis.CROL_DISABLE_ROOT_HASH_BOOT = true")
        control.goto(f"{BASE}#land/2022M0258", wait_until="domcontentloaded", timeout=60_000)
        control.locator("[data-near-you-root]").wait_for(state="visible", timeout=30_000)
        failed_as_expected = False
        try:
            control.locator("#land-item-card").wait_for(state="attached", timeout=1_500)
        except PlaywrightTimeoutError:
            failed_as_expected = True
        assert failed_as_expected, "positive control unexpectedly reached the Land SPA view"
        control.close()

        browser.close()

    print(f"root hash deep links OK routes={len(route_ids)} bare=near-you unknown=near-you control=failed")


if __name__ == "__main__":
    main()
