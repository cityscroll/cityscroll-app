"""Characterization gate for the two-tier lens navigation.

The primary Contracts and Zoning tabs stay visible at both review widths. The
four supported secondary lenses are revealed by one disclosure action, while
legacy lens hashes continue to select their panes and synchronize disclosure
state. Alerts remains a route and watch-creation destination, not a nav tab.
"""

import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
VIEWPORTS = [(390, 844), (1440, 900)]
PRIMARY = ["money", "land"]
SECONDARY = ["people", "property", "rules", "meetings"]


def nav_state(page):
    return page.evaluate(
        """() => ({
          expanded: document.querySelector('#more-tabs-toggle')?.getAttribute('aria-expanded'),
          panelHidden: document.querySelector('#secondary-tabs')?.hidden,
          activeTab: document.querySelector('.tabbtn.active')?.dataset.tab || null,
          activePane: document.querySelector('.tabpane.active')?.id || null
        })"""
    )


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()

    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.route("https://**", lambda route: route.abort())
        page.goto(BASE + "#money", wait_until="domcontentloaded")

        assert page.locator(".lens-nav").get_attribute("aria-label")
        assert page.locator(".primary-tabs").get_attribute("role") == "tablist"
        assert page.locator("#secondary-tabs").get_attribute("role") == "tablist"
        assert page.locator("#more-tabs-toggle").get_attribute("aria-controls") == "secondary-tabs"
        assert page.locator('.tabbtn[data-tab="alerts"]').count() == 0

        for lens in PRIMARY:
            tab = page.locator(f'.primary-tabs .tabbtn[data-tab="{lens}"]')
            assert tab.is_visible(), f"{lens} primary tab hidden at {width}px"
            box = tab.bounding_box()
            assert box and box["width"] >= 24 and box["height"] >= 24

        assert nav_state(page) == {
            "expanded": "false",
            "panelHidden": True,
            "activeTab": "money",
            "activePane": "tab-money",
        }

        toggle = page.locator("#more-tabs-toggle")
        assert toggle.is_visible()
        toggle.focus()
        page.keyboard.press("Enter")
        assert toggle.get_attribute("aria-expanded") == "true"
        assert not page.locator("#secondary-tabs").get_attribute("hidden")
        assert page.locator('.primary-tabs .tabbtn[tabindex="0"]').count() == 1
        assert page.locator('#secondary-tabs .tabbtn[tabindex="0"]').count() == 1

        for lens in SECONDARY:
            tab = page.locator(f'#secondary-tabs .tabbtn[data-tab="{lens}"]')
            assert tab.is_visible(), f"{lens} unavailable after one disclosure at {width}px"
            box = tab.bounding_box()
            assert box and box["width"] >= 24 and box["height"] >= 24

        context.close()

    context = browser.new_context(viewport={"width": 390, "height": 844})
    page = context.new_page()
    page.route("https://**", lambda route: route.abort())
    expected = {
        "money": ("false", True, "money"),
        "land": ("false", True, "land"),
        "people": ("true", False, "people"),
        "property": ("true", False, "property"),
        "rules": ("true", False, "rules"),
        "meetings": ("true", False, "meetings"),
        "alerts": ("false", True, None),
    }
    for lens, (expanded, hidden, active) in expected.items():
        page.goto(BASE + f"#{lens}", wait_until="domcontentloaded")
        state = nav_state(page)
        assert state["expanded"] == expanded, (lens, state)
        assert state["panelHidden"] is hidden, (lens, state)
        assert state["activeTab"] == active, (lens, state)
        assert state["activePane"] == f"tab-{lens}", (lens, state)

    for lens in SECONDARY:
        interaction_page = context.new_page()
        interaction_page.route("https://**", lambda route: route.abort())
        interaction_page.goto(BASE + "#money", wait_until="domcontentloaded")
        interaction_page.locator("#more-tabs-toggle").click()
        interaction_page.locator(f'#secondary-tabs .tabbtn[data-tab="{lens}"]').click()
        state = nav_state(interaction_page)
        assert state["activeTab"] == lens
        assert state["activePane"] == f"tab-{lens}"
        assert state["expanded"] == "true"
        assert interaction_page.evaluate("location.hash").startswith(f"#{lens}")
        interaction_page.close()

    context.close()
    browser.close()

print("✅ two-tier navigation is responsive, operable, and legacy-hash compatible")
