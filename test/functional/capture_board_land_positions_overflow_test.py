"""Regression proof: board land-position capture reveals overflow before scroll.

tools/capture_board_land_positions_evidence.py inspects a named project on a
community board page. When the board carries more recorded positions than the
initially visible limit, that project's inspect control lives inside a collapsed
`.board-land-positions-overflow` (:target disclosure): it exists in the DOM but
is not displayed. Calling scroll_into_view_if_needed on it then waits for the
full Playwright timeout, which is exactly what failed the scheduled dataset
refresh rebuild step on 2026-11-06 (cityscroll/cityscroll-app run 42234977802).

reveal_position_if_needed must click the overflow "more" control first when the
target inspect button is present but hidden, then return the same locator the
journey already scrolls and clicks.
"""

from __future__ import annotations

import pathlib
import sys
import types
import unittest


playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.sync_playwright = lambda: None
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = sync_api

TOOLS = pathlib.Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))
from capture_board_land_positions_evidence import (  # noqa: E402
    INSPECT,
    OVERFLOW_MORE,
    POSITIVE_PROJECT,
    reveal_position_if_needed,
)


class FakeLocator:
    def __init__(self, *, count=0, visible=False):
        self._count = count
        self._visible = visible
        self.clicks = 0

    def count(self):
        return self._count

    @property
    def first(self):
        return self

    def is_visible(self):
        return self._visible

    def click(self):
        self.clicks += 1
        self._visible = True


class FakePage:
    def __init__(self, locators):
        self.locators = locators
        self.locator_calls = []

    def locator(self, selector):
        self.locator_calls.append(selector)
        return self.locators[selector]


class RevealOverflowTest(unittest.TestCase):
    def test_clicks_overflow_more_when_target_is_hidden(self):
        target = FakeLocator(count=1, visible=False)
        more = FakeLocator(count=1, visible=True)
        page = FakePage({
            f'{INSPECT}[data-board-land-position-id="{POSITIVE_PROJECT}"]': target,
            OVERFLOW_MORE: more,
        })

        returned = reveal_position_if_needed(page, POSITIVE_PROJECT)

        self.assertIs(returned, target)
        self.assertEqual(more.clicks, 1)
        self.assertEqual(
            page.locator_calls,
            [
                f'{INSPECT}[data-board-land-position-id="{POSITIVE_PROJECT}"]',
                OVERFLOW_MORE,
            ],
        )

    def test_skips_overflow_when_target_is_already_visible(self):
        target = FakeLocator(count=1, visible=True)
        more = FakeLocator(count=1, visible=True)
        page = FakePage({
            f'{INSPECT}[data-board-land-position-id="{POSITIVE_PROJECT}"]': target,
            OVERFLOW_MORE: more,
        })

        returned = reveal_position_if_needed(page, POSITIVE_PROJECT)

        self.assertIs(returned, target)
        self.assertEqual(more.clicks, 0)
        self.assertEqual(
            page.locator_calls,
            [f'{INSPECT}[data-board-land-position-id="{POSITIVE_PROJECT}"]'],
        )


if __name__ == "__main__":
    raise SystemExit(unittest.main())
