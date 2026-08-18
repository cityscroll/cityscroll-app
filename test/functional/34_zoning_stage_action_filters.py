#!/usr/bin/env python3
"""Browser proof for orthogonal Zoning stage and future-action filters."""

from __future__ import annotations

import json
import os
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
FIELD_PROJECT_ID = "2024Q0292"
FIELD_PROJECT_NAME = "108-05 68th Road Rezoning"
CANONICAL_PERMALINK = f"https://cityscroll.org/browse/zoning/#land/{FIELD_PROJECT_ID}"


def install_clock(context) -> None:
    context.add_init_script(
        """
        (() => {
          const NativeDate = Date;
          const fixed = NativeDate.parse('2026-08-17T12:00:00-04:00');
          class FixedDate extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [fixed])); }
            static now() { return fixed; }
          }
          window.Date = FixedDate;
        })();
        """
    )


def wait_for_results(page) -> None:
    page.wait_for_function(
        """projectId => [...document.querySelectorAll('#llist .row a')]
          .some(link => link.getAttribute('href')?.endsWith(`#land/${projectId}`))""",
        arg=FIELD_PROJECT_ID,
    )


def scope_from_link(href: str) -> dict:
    query = parse_qs(urlparse(href).query)
    return json.loads(query["facet"][0])


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        install_clock(context)
        page = context.new_page()
        page.goto(
            f"{BASE}/browse/zoning/?stage=public_review&future=hearing",
            wait_until="domcontentloaded",
            timeout=30_000,
        )
        wait_for_results(page)

        assert page.locator("#lstage").input_value() == "public_review"
        assert page.locator("#lfuture").input_value() == "hearing"
        assert "legacy=unsupported-filter" not in page.url
        assert "stage=public_review" in page.url and "future=hearing" in page.url

        field_row = page.locator(
            f'#llist .row:has(a[href$="#land/{FIELD_PROJECT_ID}"])'
        )
        assert FIELD_PROJECT_NAME in field_row.inner_text()
        assert "Next hearing: 2026-08-26" in field_row.inner_text()
        assert (
            field_row.locator("[data-object-card-copy]").get_attribute("data-object-card-copy")
            == CANONICAL_PERMALINK
        )

        for button in page.locator("#llist [data-object-card-copy]").all():
            href = button.get_attribute("data-object-card-copy") or ""
            assert href.startswith("https://cityscroll.org/browse/zoning/#land/"), href

        near_href = page.locator('#land-borough-rail [data-near-you-link]').get_attribute("href")
        assert scope_from_link(near_href) == {
            "stage": "public_review",
            "futureAction": "hearing",
        }

        following_href = page.locator("#homeCtaTopics").get_attribute("href")
        following_query = parse_qs(urlparse(following_href).query)
        following_filter = json.loads(following_query["filter"][0])
        assert following_filter["stage"] == "public_review"
        assert following_filter["futureAction"] == "hearing"

        page.reload(wait_until="domcontentloaded")
        wait_for_results(page)
        assert page.locator("#lstage").input_value() == "public_review"
        assert page.locator("#lfuture").input_value() == "hearing"

        page.goto(
            f"{BASE}/browse/zoning/?status=public%3AIn+Public+Review",
            wait_until="domcontentloaded",
            timeout=30_000,
        )
        page.wait_for_function("() => document.querySelectorAll('#llist .row').length > 0")
        statuses = page.locator("#llist .row .rmeta").all_inner_texts()
        assert statuses and all("In Public Review" in status for status in statuses)

        context.close()
        browser.close()
    print("PASS: Zoning stage/action URLs, handoffs, and canonical project links round-trip")


if __name__ == "__main__":
    main()
