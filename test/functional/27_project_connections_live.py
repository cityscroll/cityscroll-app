#!/usr/bin/env python3
"""Post-deploy browser smoke for the Land project-connections contract."""

from __future__ import annotations

import json
import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "https://cityscroll.org/").rstrip("/") + "/"
PROJECT_ID = os.environ.get("CROL_PROJECT_CONNECTIONS_ID", "2024Q0135")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 960})
        api_origin = os.environ.get("CROL_API_ORIGIN")
        if api_origin:
            page.add_init_script(
                f"window.CROL_API_ORIGIN = {json.dumps(api_origin)}; "
                f"window.CROL_API_FALLBACK_ORIGIN = {json.dumps(api_origin)};"
            )
        page.goto(f"{BASE}#land/{PROJECT_ID}", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector("#project-connections", state="attached", timeout=60_000)
        page.wait_for_timeout(2_000)
        available = page.locator(f'.project-connections[data-project-ref="project:{PROJECT_ID}"]')
        host = page.locator("#project-connections")
        if available.count():
            expected_groups = {
                "applicant": "Applied by",
                "parcels": "Touches parcels",
                "meetings": "Considered by",
                "decisions": "Decided by",
                "notices": "Related published notices",
                "mih": "Mandatory Inclusionary Housing",
            }
            rendered = available.locator(".pc-group")
            groups = rendered.count()
            actual_groups = {
                rendered.nth(index).get_attribute("data-project-group"): rendered.nth(index).locator("h3").inner_text()
                for index in range(groups)
            }
            unknown_groups = actual_groups.keys() - expected_groups.keys()
            if unknown_groups:
                raise AssertionError(f"project connections rendered unknown groups {sorted(unknown_groups)}")
            for group_id, label in expected_groups.items():
                if group_id not in actual_groups:
                    continue
                if label.lower() not in actual_groups[group_id].lower():
                    raise AssertionError(f"project group {group_id} rendered without honest label {label!r}: {actual_groups[group_id]!r}")
            if groups == 0:
                raise AssertionError("project connections rendered no populated groups")
            if available.locator('.pc-group[data-status]:not([data-status="matched"])').count():
                raise AssertionError("an empty project connection group reached the reader surface")
            text = available.inner_text()
            forbidden = ("Coverage:", "snapshot", " as scope", " as a scope", "facet", "pivot")
            if any(term.lower() in text.lower() for term in forbidden):
                raise AssertionError(f"internal constellation copy leaked: {text}")
            for evidence in available.locator('.entity-pivot-evidence').all():
                if not evidence.get_attribute("title"):
                    raise AssertionError("evidence affordance has no reader text")
            dead_agency = available.locator('a[href*="/agencies/edc-economic-development-corporation-for-nyc/"]')
            if dead_agency.count():
                raise AssertionError("unresolved EDC identity became an agency pivot")
            if PROJECT_ID == "2024Q0135" and "EDC - Economic Development Corporation for NYC (organization)" not in text:
                raise AssertionError(f"unresolved applicant was not labeled as an organization: {text}")
            print(f"project-connections browser smoke OK state=available groups={groups} ids={sorted(actual_groups)}")
            pivot_page = browser.new_page()
            for link in available.locator('a[href^="/agencies/"]').all():
                href = link.get_attribute("href")
                if not href:
                    continue
                pivot_page.goto(f"{BASE.rstrip('/')}{href}", wait_until="domcontentloaded", timeout=60_000)
                if "could not connect" in pivot_page.locator("body").inner_text().lower():
                    raise AssertionError(f"agency pivot destination is unresolved: {href}")
            pivot_page.close()
        elif not host.inner_html().strip():
            print("project-connections browser smoke OK state=omitted")
        else:
            raise AssertionError("project connections rendered an unpopulated placeholder")
        browser.close()


if __name__ == "__main__":
    main()
